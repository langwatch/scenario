/**
 * ElevenLabs adapters — both the hosted ConvAI transport and the local
 * branded composable preset live here (one ElevenLabs file).
 *
 * TypeScript port of `python/scenario/voice/adapters/elevenlabs.py` +
 * `composable.py`'s `ElevenLabsVoiceAgent`.
 *
 * {@link ElevenLabsAgentAdapter} — hosted ElevenLabs Conversational AI, driven by
 * the OFFICIAL `@elevenlabs/elevenlabs-js` SDK's {@link Conversation} + a custom
 * {@link AudioInterface} (NOT a hand-rolled `ws` client). EL runs the STT→LLM→TTS
 * loop on their infrastructure; all audio is PCM16 @ 24 kHz mono, so nothing is
 * converted at either edge.
 *
 * Why the SDK and not a raw socket: the SDK owns the fiddly, easy-to-get-wrong
 * transport mechanics natively — the `conversation_initiation_client_data`
 * handshake, ping/pong keepalive replies, message framing, the signed-URL auth
 * handshake, and post-barge-in audio gating by `event_id`. We hand-rolled all of
 * that once (#705) and kept re-finding the same bugs the SDK already fixes; this
 * adapter delegates them and keeps ONLY the scenario-specific reliability recipe on
 * top, bridged onto the SDK's seams:
 *
 *  1. CONTINUOUS MIC, WITH A POST-RESPONSE PAUSE — our {@link AudioInterface}'s
 *     `start(inputCallback)` drives a real-time ~20 ms pump that feeds 960-byte
 *     (20 ms) frames to the SDK's `inputCallback` (the SDK base64-encodes + sends
 *     each as a `user_audio_chunk`): a user turn's PCM sliced into 20 ms frames
 *     while the turn is in flight, then one all-zero SILENCE frame per tick as the
 *     CLOSING silence once the speech drains — EL's server VAD measures end-of-turn
 *     off that audio→silence transition (no burst-send miss, and no silence-tail
 *     constant to tune). The mic then PAUSES (feeds nothing) from the moment the
 *     agent's turn audio arrives until the next user turn (#705): streaming silence
 *     straight through the inter-turn gap made EL read the user as having LEFT and
 *     fire its "I didn't quite catch that… are you still there?" idle prompt on the
 *     slow/judged path. WS liveness across that silent gap is the SDK's ping/pong
 *     keepalive, NOT the audio stream, and there is still NO separate
 *     `user_activity` keepalive.
 *  2. NATIVE TRANSCRIPTS — `callbackUserTranscript` → {@link lastUserTranscript};
 *     `callbackAgentResponse`/`callbackAgentResponseCorrection` →
 *     {@link lastAgentTranscript}.
 *  3. pcm_24000 byte-passthrough — the Conversation WS is a byte pipe, so our
 *     24 kHz PCM passes through unchanged; a format-drift warning fires if EL's
 *     advertised input/output format differs.
 *
 * Push→pull bridge: the SDK PUSHES agent audio at us via `AudioInterface.output`;
 * the executor PULLS via {@link receiveAudio}. `output()` buffers each agent chunk
 * onto an internal queue (or hands it to a parked waiter), and `receiveAudio`
 * drains that queue with the same sliding-idle-deadline + absolute hard-ceiling
 * timeout the hand-rolled version used. A `client_tool_call` (tool-only terminal
 * turn) or a session close/error resolves the parked waiter with an empty chunk so
 * the drain exits cleanly instead of hanging.
 *
 * {@link ElevenLabsVoiceAgent} — the typed *local* composable preset (distinct
 * responsibility, same vendor): you compose {@link ElevenLabsSTTProvider} + any
 * LLM + ElevenLabs TTS yourself, keeping control over prompts, model choice,
 * and tool calls. Collapsed in from the former `eleven-labs-voice-agent.ts`
 * (one ElevenLabs file; the two filenames were an as-built artifact).
 */
import { Buffer } from "node:buffer";

import { openai } from "@ai-sdk/openai";
// The Conversation constructor types its `client` as the *base* Fern client
// (`@elevenlabs/elevenlabs-js/Client`), NOT the root-export wrapper
// (`@elevenlabs/elevenlabs-js`). The wrapper extends the base but, under TS
// private-field nominal typing, is not assignable to it — so the hosted adapter
// constructs the base client directly. (STT/TTS keep using the root wrapper.)
// EXPLICIT-FILE imports: a directory/package import of `.../conversation` resolves
// to its `index.js` barrel, which fails under our ESM (`moduleResolution: bundler`)
// build — import the concrete files instead.
import { AudioInterface } from "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/AudioInterface";
import { Conversation } from "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/Conversation";
import type { ConversationClient } from "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/interfaces/ConversationClient";
import type { WebSocketFactory } from "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/interfaces/WebSocketInterface";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js/Client";
import type { LanguageModel } from "ai";

import { AgentRole } from "../../domain/agents";
import { Logger } from "../../utils/logger";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import {
  COMPOSABLE_VOICE_LLM_MODEL,
  ELEVENLABS_DEFAULT_VOICE_ID,
} from "../voice-models";
import {
  ComposableVoiceAgent,
  ElevenLabsSTTProvider,
  type STTProvider,
  type SynthesizeOptions,
} from "./composable";

/**
 * Canonical hosted-ConvAI endpoint for an agent. Informational: the SDK opens the
 * socket itself (and, with `requiresAuth`, derives a short-lived *signed* URL from
 * this base and appends `&source`/`&version`), so this template is no longer used
 * to dial — it documents where a hosted ConvAI agent lives.
 */
export const ELEVENLABS_CONVAI_URL_TEMPLATE =
  "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}";

/**
 * One 20 ms PCM16/24 kHz mono frame: 24000 Hz × 2 bytes/sample × 0.020 s = 960
 * bytes. The continuous mic pump feeds exactly one such frame per tick to the SDK's
 * `inputCallback` so user audio reaches EL at real-microphone cadence instead of
 * one instant burst — the burst is the suspected cause of EL's intermittent
 * end-of-turn miss (no `user_transcript`/audio on a chunk of hosted multi-turn
 * runs).
 */
const PUMP_FRAME_BYTES = 960;

/**
 * Continuous mic pump cadence (ms): one {@link PUMP_FRAME_BYTES} frame every 20 ms
 * == real-time 24 kHz mono. Queued speech frames while a turn is in flight, then a
 * {@link SILENCE_FRAME} as the closing silence EL's server VAD measures end-of-turn
 * against — until the agent's turn audio arrives, after which {@link
 * ElevenLabsAgentAdapter.pumpTick} PAUSES the idle mic until the next user turn (the
 * #705 post-response pause).
 */
const PUMP_INTERVAL_MS = 20;

/**
 * Absolute wall-clock ceiling (seconds) for a single {@link
 * ElevenLabsAgentAdapter.receiveAudio} call that liveness frames do NOT reset.
 *
 * The idle deadline (`timeout`) is re-armed on every inbound frame, pings included
 * (the liveness-driven idle-timer reset via {@link onMessage}), so a
 * slow-but-pinging server is not aborted mid-think. But EL ConvAI keeps pinging
 * *indefinitely* on a turn it will never answer with audio (e.g. after it ends or
 * transfers its turn) — with only the ping-resettable idle deadline, `receiveAudio`
 * then waits forever and wedges the whole multi-turn run (the keepalive-ping
 * wedge). This ceiling bounds that pings-but-no-audio case: generous enough (45s)
 * that a genuinely slow agent still gets to respond, but finite, so a
 * non-responding turn times out cleanly and the drain moves on.
 */
const KEEPALIVE_HARD_CEILING_S = 45;

/**
 * One all-zero (silence) {@link PUMP_FRAME_BYTES} frame — the closing-silence frame
 * of the continuous mic pump. {@link ElevenLabsAgentAdapter.pumpTick} feeds this on
 * a tick whose outbound queue is empty AND whose user turn is still closing (before
 * the agent responds), so EL's server VAD has the audio→silence transition it
 * measures end-of-turn against; once the agent has responded the pump pauses instead
 * (the #705 post-response pause). The SDK only ever *reads* this buffer
 * (`toString("base64")`), so one shared immutable instance is safe to reuse.
 */
const SILENCE_FRAME = Buffer.alloc(PUMP_FRAME_BYTES);

/**
 * Concrete {@link AudioInterface} wired back to the adapter through plain hooks.
 *
 * The SDK calls `start(inputCallback)` once on session open (we capture the
 * callback + start the continuous mic pump), `stop()` once on session end (we tear
 * it down), `output(audio)` for every decoded agent-audio chunk (we buffer
 * it for {@link ElevenLabsAgentAdapter.receiveAudio}), and `interrupt()` on a
 * barge-in. Hooks (not a back-reference to the adapter) keep the adapter's private
 * members private — the closures are created inside the adapter and close over
 * `this`.
 */
class BridgeAudioInterface extends AudioInterface {
  constructor(
    private readonly hooks: {
      onStart: (inputCallback: (audio: Buffer) => void) => void;
      onStop: () => void;
      onOutput: (audio: Buffer) => void;
      onInterrupt: () => void;
    },
  ) {
    super();
  }

  override start(inputCallback: (audio: Buffer) => void): void {
    this.hooks.onStart(inputCallback);
  }

  override stop(): void {
    this.hooks.onStop();
  }

  override output(audio: Buffer): void {
    this.hooks.onOutput(audio);
  }

  override interrupt(): void {
    this.hooks.onInterrupt();
  }
}

/** A non-null, non-array object — the only value kind {@link deepMerge} recurses into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `layer` ON TOP OF `base`, returning a NEW object (neither
 * argument is mutated). When a key holds a plain object on BOTH sides the two are
 * merged key-by-key (so a shared parent like `agent` keeps keys from both); for
 * every other shape — primitive, array, or a key present on only one side —
 * `layer` wins where it supplies the key, else `base`'s value is kept.
 *
 * This is the precedence engine for the hosted adapter's
 * `conversation_config_override`: the caller's `overrides` are the `base` and the
 * adapter's narrow `{ agent: { prompt, first_message } }` is the `layer`, so the
 * narrow knobs win on a shared LEAF (e.g. `agent.prompt.prompt`) while sibling
 * caller keys (e.g. `agent.language`, a top-level `tts`) survive the merge intact.
 * A shallow `{ ...base, ...layer }` would instead DROP one side's nested `agent`.
 */
function deepMerge(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, layerValue] of Object.entries(layer)) {
    const baseValue = out[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(layerValue)
        ? deepMerge(baseValue, layerValue)
        : layerValue;
  }
  return out;
}

export interface ElevenLabsAgentAdapterOptions {
  /** ID of the ElevenLabs Conversational AI agent (provisioned in the EL dashboard). */
  agentId: string;
  /** ElevenLabs API key (`xi-api-key`). */
  apiKey: string;
  /**
   * Per-session system prompt override applied via the SDK's
   * `conversationConfigOverride.agent.prompt.prompt`. Lets demos use a different
   * prompt shape without mutating the shared test agent.
   */
  systemPromptOverride?: string;
  /** Per-session first message override (`conversationConfigOverride.agent.first_message`). */
  firstMessageOverride?: string;
  /**
   * Per-call **dynamic variables**, forwarded NATIVELY to ElevenLabs as the init
   * handshake's `dynamic_variables`. EL personalizes a hosted agent per call from
   * these: a call-init webhook keyed on e.g. a tenant/org id resolves that call's
   * system prompt, first message, and task context.
   *
   * Values pass through with their native JSON type — Text (`string`), Numeric
   * (`number`), or Boolean (`boolean`) — with NO `String()` coercion, matching EL's
   * typed dynamic-variable support. A key whose value is `undefined` is dropped
   * before sending (the JSON serializer omits it). When this option is unset the
   * adapter sends no `dynamic_variables` at all (not an empty `{}`).
   *
   * Applied only if the agent is configured to allow it — EL ignores variables the
   * agent has not declared (server-side allowlist).
   *
   * @example
   * scenario.elevenLabsAgent({
   *   agentId, apiKey,
   *   dynamicVariables: { tenant_id: "acme", seat_tier: 2, is_vip: true },
   * });
   */
  dynamicVariables?: Record<string, string | number | boolean>;
  /**
   * Per-call **conversation-config overrides**, DEEP-merged into the init
   * handshake's `conversation_config_override`. Use this for any override the
   * narrow {@link ElevenLabsAgentAdapterOptions.systemPromptOverride}/{@link
   * ElevenLabsAgentAdapterOptions.firstMessageOverride} knobs do not cover (e.g.
   * `{ agent: { language: "es" }, tts: { stability: 0.3 } }`).
   *
   * Merge + precedence: the caller's `overrides` are applied FIRST, then the narrow
   * `systemPromptOverride`/`firstMessageOverride` are layered on top — so the narrow
   * knobs take precedence over the same keys here (`agent.prompt.prompt`,
   * `agent.first_message`), while the shared top-level `agent` key DEEP-merges so a
   * caller's `agent.language` and the adapter's `agent.prompt` BOTH survive.
   *
   * Applied only if the agent is configured to allow it — EL ignores
   * non-allowlisted overrides server-side.
   *
   * @example
   * scenario.elevenLabsAgent({
   *   agentId, apiKey,
   *   overrides: { agent: { language: "es" }, tts: { stability: 0.3 } },
   * });
   */
  overrides?: Record<string, unknown>;
  /**
   * @deprecated No-op, retained only for back-compat of the options type. The
   * adapter no longer appends a bounded silence tail to close a turn: the
   * continuous mic pump (Strategy B′) streams silence on every idle tick, and EL's
   * server VAD closes the turn off that continuous audio→silence transition. Any
   * value passed here is accepted and ignored.
   */
  silenceTailBytes?: number;
  /**
   * SDK WebSocket factory — injected for unit tests so the real `Conversation`
   * runs against an in-memory socket (no network). Production callers leave this
   * unset; the SDK's `DefaultWebSocketFactory` (the `ws` package) is used.
   */
  webSocketFactory?: WebSocketFactory;
  /**
   * SDK conversation client used ONLY for the `requiresAuth` signed-URL handshake
   * — injected for unit tests so `startSession()` does not make a real
   * `getSignedUrl` HTTP call. Production callers leave this unset; the adapter's
   * authenticated {@link ElevenLabsClient} is used.
   */
  conversationClient?: ConversationClient;
}

/**
 * Hosted ElevenLabs Conversational AI adapter (official-SDK transport).
 *
 * Connect (build an {@link ElevenLabsClient} + a {@link Conversation} over our
 * {@link AudioInterface} and start the session), stream PCM16 audio chunks at
 * real-mic cadence, and drain agent audio the SDK pushes via `output()`.
 */
export class ElevenLabsAgentAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;

  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: true,
    dtmf: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  readonly agentId: string;
  private readonly apiKey: string;
  private readonly systemPromptOverride?: string;
  private readonly firstMessageOverride?: string;
  private readonly dynamicVariables?: Record<string, string | number | boolean>;
  private readonly overrides?: Record<string, unknown>;
  private readonly webSocketFactory?: WebSocketFactory;
  private readonly conversationClient?: ConversationClient;

  /** Live SDK session; null whenever disconnected (or before the first connect). */
  private conversation: Conversation | null = null;
  /**
   * The SDK's mic-input sink, captured when the SDK calls `AudioInterface.start`
   * on session open. The continuous mic pump feeds it one frame per tick; the SDK
   * base64-encodes each frame and sends it as a `user_audio_chunk`. Null while no
   * session is active.
   */
  private inputCallback: ((audio: Buffer) => void) | null = null;

  /** Queue of agent audio chunks the SDK pushed via `output()` ahead of a receiver. */
  private readonly audioQueue: AudioChunk[] = [];
  /** Resolvers waiting on the next agent audio chunk (FIFO). */
  private readonly waiters: Array<(chunk: AudioChunk) => void> = [];
  /** Idle-timer-reset callbacks for active receiveAudio calls — called on every inbound frame. */
  private readonly timerResetters: Array<() => void> = [];

  /**
   * Continuous mic pump outbound queue: 20 ms PCM frames enqueued by {@link
   * sendAudio} (the user turn's speech, sliced into 20 ms frames) and drained
   * one-per-tick by the pump, each fed to the SDK's `inputCallback`. When the queue
   * is EMPTY the pump feeds a {@link SILENCE_FRAME} — the closing silence EL's server
   * VAD measures end-of-turn against — UNTIL the agent's turn audio arrives ({@link
   * awaitingUserTurn}), after which the pump PAUSES (feeds nothing) through the
   * inter-turn gap so EL does not read the gap as the user having left.
   */
  private readonly outboundFrames: Buffer[] = [];
  /** Interval handle for the continuous mic pump; null whenever the pump is stopped. */
  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Post-response pause flag (#705). FALSE while the user's turn is in flight or
   * closing — the pump streams queued speech, then the closing {@link SILENCE_FRAME}
   * so EL's server VAD can measure end-of-turn. Flipped TRUE the moment the agent's
   * turn audio arrives ({@link onAgentAudio}) so {@link pumpTick} stops streaming
   * idle silence into the inter-turn gap, and cleared FALSE again when the next user
   * turn starts ({@link enqueueSpeech}). Streaming silence straight through the gap
   * made EL read the user as having LEFT and fire its "are you still there?" idle
   * prompt on the slow/judged path (the #705 idle-prompt storm). Reset in {@link
   * stopPump} so a reconnect starts clean.
   */
  private awaitingUserTurn = false;

  lastUserTranscript: string | null = null;
  lastAgentTranscript: string | null = null;

  /**
   * Wall-clock (ms) of the most-recent agent AUDIO frame for the current turn
   * (#734). Set in {@link onAgentAudio}; read in `callbackAgentResponse` to log
   * how far the `agent_response` TRANSCRIPT event lags the audio it describes.
   * That per-turn lag is the direct measurement behind the grace-wait: a
   * POSITIVE lag past `responseTailSilence` is a turn that would have lost the
   * race (transcript arriving after audio-silence drain-close) — i.e. the
   * late-vs-never signal the fix (AC4) makes observable in live runs.
   */
  private lastAgentAudioAtMs: number | null = null;

  /** Debug logger for the #734 transcript-lag instrumentation (AC4). */
  private readonly logger = new Logger("ElevenLabsAgentAdapter");

  /**
   * How many user turns this adapter committed by streaming real PCM. The
   * voice-specific assertion keys on this together with {@link
   * lastUserTranscript}: a non-empty `user_transcript` after `audioCommitCount`
   * turns proves EL's STT actually ran on the audio we sent (audio reached the
   * agent) — strictly stronger than the older `>=N segments` check, which passed
   * even on the old text-commit path where no PCM ever reached EL.
   */
  audioCommitCount = 0;

  constructor(options: ElevenLabsAgentAdapterOptions) {
    super();
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.systemPromptOverride = options.systemPromptOverride;
    this.firstMessageOverride = options.firstMessageOverride;
    this.dynamicVariables = options.dynamicVariables;
    this.overrides = options.overrides;
    // `silenceTailBytes` is a deprecated no-op (see the option's JSDoc): the
    // continuous mic pump replaced the bounded silence tail, so the value is
    // neither stored nor read.
    this.webSocketFactory = options.webSocketFactory;
    this.conversationClient = options.conversationClient;
  }

  /**
   * Canonical base endpoint for this adapter's agent. Informational only — the SDK
   * dials the (signed) socket itself; see {@link ELEVENLABS_CONVAI_URL_TEMPLATE}.
   */
  get url(): string {
    return ELEVENLABS_CONVAI_URL_TEMPLATE.replace("{agent_id}", this.agentId);
  }

  /** Hides the API key. */
  override toString(): string {
    return `ElevenLabsAgentAdapter(agentId='${this.agentId}', apiKey='***')`;
  }

  // call() is inherited from VoiceAgentAdapter (defaultVoiceCall) — the executor
  // drives the hosted ConvAI audio loop. No leaf-level override.

  // ---------------------------------------------------------------- lifecycle
  async connect(): Promise<void> {
    const client = new ElevenLabsClient({ apiKey: this.apiKey });

    // The adapter's NARROW prompt/first-message knobs build an `agent` override
    // that is always sent (an empty `agent` object is a no-op) so the handshake
    // shape is stable; it carries the prompt/first-message overrides when set.
    const agentOverride: Record<string, unknown> = {};
    if (this.systemPromptOverride) {
      agentOverride.prompt = { prompt: this.systemPromptOverride };
    }
    if (this.firstMessageOverride) {
      agentOverride.first_message = this.firstMessageOverride;
    }

    // DEEP-merge the caller's `overrides` (the base, lower precedence) UNDER the
    // adapter's narrow `{ agent: agentOverride }` (the layer, higher precedence).
    // The shared top-level `agent` key deep-merges, so a caller's `agent.language`
    // and our `agent.prompt`/`agent.first_message` BOTH survive; on a shared LEAF
    // (e.g. `agent.prompt.prompt`) the narrow override wins. A shallow spread would
    // drop one side's nested `agent` — see deepMerge.
    const conversationConfigOverride = deepMerge(this.overrides ?? {}, {
      agent: agentOverride,
    });

    const audioInterface = new BridgeAudioInterface({
      onStart: (inputCallback) => this.onAudioStart(inputCallback),
      onStop: () => this.onAudioStop(),
      onOutput: (audio) => this.onAgentAudio(audio),
      onInterrupt: () => this.onAgentInterrupt(),
    });

    const conversation = new Conversation({
      client,
      agentId: this.agentId,
      // Hosted agents are private: the signed-URL handshake (getSignedUrl, run by
      // the SDK with our authenticated client) is the only way the WS authenticates
      // — `requiresAuth: false` would dial with no credentials and only work for a
      // PUBLIC agent.
      requiresAuth: true,
      audioInterface,
      config: {
        conversationConfigOverride,
        // Dynamic variables pass through NATIVELY — no `String()` coercion, since
        // EL accepts Text/Numeric/Boolean values. When unset this is `undefined`,
        // and the SDK (which forwards `config.dynamicVariables` verbatim into the
        // init frame) omits `dynamic_variables` entirely rather than sending `{}`.
        dynamicVariables: this.dynamicVariables,
      },
      // undefined in production → the SDK falls back to its DefaultWebSocketFactory
      // and to `client` for getSignedUrl. Set only by unit tests.
      webSocketFactory: this.webSocketFactory,
      conversationClient: this.conversationClient,
      callbackUserTranscript: (transcript) => {
        this.lastUserTranscript = transcript;
      },
      callbackAgentResponse: (response) => {
        // #734 (AC4) — measure how far this transcript event lags the audio it
        // describes. A lag exceeding `responseTailSilence` is a turn whose
        // transcript would have LOST the drain-close race pre-fix; the grace-wait
        // now covers it. Emitting the per-turn lag makes late-vs-never (the
        // issue's open question) observable in a forced-race run. Debug-level:
        // silent by default, surfaced with LOG_LEVEL=debug.
        const audioAt = this.lastAgentAudioAtMs;
        const lagMs = audioAt !== null ? Date.now() - audioAt : null;
        this.logger.debug("agent_response transcript received", {
          transcriptLagMs: lagMs,
          responseTailSilenceMs: this.responseTailSilence * 1000,
          lostRacePreFix: lagMs !== null && lagMs > this.responseTailSilence * 1000,
        });
        this.lastAgentTranscript = response;
      },
      callbackAgentResponseCorrection: (_original, corrected) => {
        // Post-barge-in correction replaces the agent transcript.
        this.lastAgentTranscript = corrected;
      },
      // Fires for EVERY inbound message (ping included) AFTER the SDK has routed it
      // — our universal liveness + terminal-turn hook. See onMessage.
      callbackMessageReceived: (message) => this.onMessage(message),
    });

    // The SDK re-emits WS errors as an `error` event on the Conversation itself; an
    // unheard EventEmitter `error` would crash the process, so this listener is
    // load-bearing (not just observability). `session_ended` fires on both a clean
    // endSession and a socket close — drain parked receivers in either case.
    conversation.on("error", (err: Error) => this.onSessionError(err));
    conversation.on("session_ended", () => this.onSessionEnded());

    this.conversation = conversation;
    // Resolves on WS open; the SDK has by then called AudioInterface.start, so the
    // pump + keepalive are already running and inputCallback is captured.
    await conversation.startSession();
  }

  /** The SDK opened the session and handed us the mic sink. */
  private onAudioStart(inputCallback: (audio: Buffer) => void): void {
    this.inputCallback = inputCallback;
    this.startPump();
  }

  /** The SDK ended the session (endSession → AudioInterface.stop). */
  private onAudioStop(): void {
    this.inputCallback = null;
    this.stopPump();
  }

  /** Agent audio the SDK decoded and pushed; buffer it for {@link receiveAudio}. */
  private onAgentAudio(audio: Buffer): void {
    // The agent's turn audio has arrived → engage the post-response pause: {@link
    // pumpTick} stops streaming idle silence into the inter-turn gap until the next
    // user turn ({@link enqueueSpeech} clears the flag). Idempotent — the FIRST
    // agent frame of the response is the real transition; later frames re-assert it.
    this.awaitingUserTurn = true;
    // #734 — stamp the last agent-audio arrival so callbackAgentResponse can log
    // transcript-lag-vs-audio-drain. Every frame re-stamps; the field therefore
    // holds the LAST audio frame of the turn, the tightest baseline for the lag.
    this.lastAgentAudioAtMs = Date.now();
    // EL audio is PCM16 (even byte count); trim a stray odd byte defensively so the
    // AudioChunk invariant never throws.
    let pcm = audio;
    if (pcm.length % 2 === 1) pcm = pcm.subarray(0, pcm.length - 1);
    const chunk = new AudioChunk({ data: new Uint8Array(pcm) });
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.audioQueue.push(chunk);
  }

  /**
   * EL signalled a barge-in. Swallowed: the SDK already drops post-interrupt agent
   * audio by `event_id`, so there is nothing extra to do here (parity with the
   * prior adapter, which also swallowed `interruption`).
   */
  private onAgentInterrupt(): void {
    // no-op
  }

  /** Called when the SDK re-emits a WS `error` on the Conversation. */
  private onSessionError(err: Error): void {
     
    console.warn(`ElevenLabsAgentAdapter: session error: ${err.message}`);
    // Stop the pump so no frame is fed to a dead session, drain parked receivers so
    // the executor unwinds rather than hanging, and null the session so subsequent
    // sendAudio/receiveAudio fail fast with a clear "not connected".
    this.stopPump();
    this.drainPendingWaiters();
    this.inputCallback = null;
    this.conversation = null;
  }

  /** Called on `session_ended` (clean endSession OR socket close). */
  private onSessionEnded(): void {
    this.stopPump();
    this.drainPendingWaiters();
  }

  private drainPendingWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(new AudioChunk({ data: new Uint8Array(0) }));
    }
  }

  /** Whether the SDK session is open and ready to exchange audio. */
  override isConnected(): boolean {
    return this.conversation?.isSessionActive() ?? false;
  }

  async disconnect(): Promise<void> {
    // Stop the pump first so no frame is fed once teardown begins, even if
    // disconnect() races a close/error that already nulled the session.
    this.stopPump();
    const conversation = this.conversation;
    this.conversation = null;
    this.inputCallback = null;
    if (conversation) {
      try {
        // endSession() stops the AudioInterface and closes the WS, then emits
        // session_ended (→ onSessionEnded drains any stragglers).
        conversation.endSession();
      } catch {
        // Best-effort: a half-closed session can throw on teardown. We're tearing
        // down regardless — swallowing here matches the Python behavior.
      }
    }
    this.drainPendingWaiters();
  }

  // ------------------------------------------------------- continuous mic pump
  /**
   * Start the continuous mic pump. Idempotent. Called from {@link onAudioStart}
   * (i.e. once the SDK has opened the session), so the interval never outlives the
   * socket. While it runs, {@link pumpTick} feeds one 20 ms frame to the SDK every
   * {@link PUMP_INTERVAL_MS} — queued speech during a turn, silence when idle.
   */
  private startPump(): void {
    if (this.pumpTimer === null) {
      this.pumpTimer = setInterval(() => this.pumpTick(), PUMP_INTERVAL_MS);
    }
  }

  /**
   * Stop the continuous mic pump and drop any unsent frames. Called from {@link
   * onAudioStop}, {@link disconnect}, and the session error/ended handlers, so the
   * interval never outlives the session.
   */
  private stopPump(): void {
    if (this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.outboundFrames.length = 0;
    // Reset the post-response pause so a reconnect starts in the closing-silence
    // state — the next user turn streams its closing silence as normal.
    this.awaitingUserTurn = false;
  }

  /**
   * One pump tick — one of three outcomes, gated on the session being active so a
   * frame that races a close cannot reach a dead socket:
   *
   *  - QUEUED SPEECH present → feed it (the user is speaking).
   *  - else AWAITING the next user turn ({@link awaitingUserTurn}, i.e. the agent
   *    has already responded since the last user turn) → feed NOTHING this tick.
   *  - else → feed one {@link SILENCE_FRAME}: the CLOSING silence after the user's
   *    speech, before the agent responds, which EL's server VAD measures end-of-turn
   *    against (the agent's `turn_timeout` ≈7 s, provisioned on the agent, is the
   *    server-side bound).
   *
   * POST-RESPONSE PAUSE (#705): the previous "continuous silence forever when idle"
   * design left an accepted, un-engineered risk that the inter-turn gap (the
   * user-sim/judge needs several seconds to produce the next turn) could exceed EL's
   * `turn_timeout`. That risk MATERIALIZED in a live judged run: EL read the unbroken
   * run of committed-nothing silence as the user having LEFT and fired its idle
   * prompt ("I didn't quite catch that… are you still there?") repeatedly (14× in one
   * failing run), desyncing the conversation. It is now MITIGATED — the {@link
   * awaitingUserTurn} flag pauses the idle silence once the agent's turn audio has
   * arrived and resumes the closing silence on the next user turn. The pause cannot
   * starve a {@link receiveAudio}: that call's idle deadline is re-armed only by
   * INBOUND EL frames (via {@link onMessage}), never by this OUTBOUND pump. WS
   * liveness across the silent gap is the SDK's ping/pong keepalive, not the audio
   * stream, so pausing cannot drop the socket.
   */
  private pumpTick(): void {
    const callback = this.inputCallback;
    if (!callback || !this.isConnected()) return;

    const speechFrame = this.outboundFrames.shift();
    let frame: Buffer;
    if (speechFrame) {
      // The user is speaking — always feed the queued speech frame.
      frame = speechFrame;
    } else if (this.awaitingUserTurn) {
      // Agent has responded since the last user turn: PAUSE the idle mic. Streaming
      // silence into the inter-turn gap makes EL read it as the user having left and
      // fire its "are you still there?" idle prompt (#705). Feed nothing until the
      // next enqueueSpeech (a new user turn) clears the flag.
      return;
    } else {
      // Closing silence after the user's speech, before the agent responds: EL's
      // server VAD measures end-of-turn off this audio→silence transition (also what
      // preserves the receiveAudio-timeout fix).
      frame = SILENCE_FRAME;
    }

    try {
      callback(frame);
    } catch {
      // Raced a close between the active-check and the feed — drop the frame; the
      // session close/error handler tears the pump down.
    }
  }

  // ---------------------------------------------------------------- I/O
  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("ElevenLabsAgentAdapter: not connected");
    }

    // Continuous mic: instead of bursting the whole turn's PCM, slice the spoken
    // PCM into 20 ms frames and ENQUEUE them. The always-on pump (running since
    // session open) feeds one frame per ~20 ms wall-clock — real-microphone cadence
    // — draining the queued speech, then streaming the closing silence until the
    // agent responds (after which the post-response pause stops the idle mic; see
    // pumpTick). EL's server VAD sees paced speech→silence and closes the turn
    // naturally; there is no bounded silence tail to tune.
    //
    // Audio reaches EL ONLY as `user_audio_chunk` frames (the SDK encodes each fed
    // frame), never as a `{"type":"user_message","text":…}` commit — that injected
    // text and DISCARDED the audio so EL's STT never ran (the text-commit
    // regression).
    this.enqueueSpeech(chunk.data);
  }

  /**
   * Slice a user turn's PCM into fixed {@link PUMP_FRAME_BYTES} (20 ms) frames and
   * enqueue them for the continuous mic pump. Returns promptly — it does NOT block
   * until the queue drains; the pump feeds the frames at real-time cadence and, once
   * they drain, streams the closing silence (the natural end-of-turn, which EL's
   * server VAD measures off the audio→silence transition) until the agent responds.
   * No bounded silence tail is appended — the closing idle silence replaced it.
   *
   * A non-empty turn also clears {@link awaitingUserTurn}: a new user turn is
   * starting, so the post-response pause lifts and the closing silence must stream
   * again once this speech drains.
   */
  private enqueueSpeech(data: Uint8Array): void {
    // An empty chunk carries no speech: don't count it as a real-audio turn (that
    // would inflate audioCommitCount and the STT assertion), don't enqueue a
    // meaningless frame, and don't disturb the post-response pause.
    if (data.length === 0) return;
    // A real user turn is starting → lift the post-response pause so the closing
    // silence streams again once this speech drains (see pumpTick).
    this.awaitingUserTurn = false;
    // #734 — a new user turn opens a new agent turn; clear the last-audio stamp so
    // callbackAgentResponse measures transcript lag against THIS turn's audio only.
    // Without this, a turn whose transcript arrives with no fresh audio frame would
    // report lag against a PRIOR turn's audio, making transcriptLagMs/lostRacePreFix
    // (AC4 telemetry) misleading.
    this.lastAgentAudioAtMs = null;
    // Count the turn ONCE per non-empty sendAudio (not once per 20 ms frame) so the
    // STT assertion still counts turns, not frames.
    this.audioCommitCount += 1;
    for (let offset = 0; offset < data.length; offset += PUMP_FRAME_BYTES) {
      const slice = data.subarray(offset, offset + PUMP_FRAME_BYTES);
      let frame: Buffer;
      if (slice.length === PUMP_FRAME_BYTES) {
        // Copy NOW: the queued Buffer is an immutable snapshot, so a later
        // mutation/reuse of `data`'s backing buffer cannot corrupt a not-yet-fed
        // frame.
        frame = Buffer.from(slice);
      } else {
        // Pad the final partial frame to a full 20 ms with trailing zeros so the
        // pump only ever feeds fixed-size frames.
        frame = Buffer.alloc(PUMP_FRAME_BYTES);
        Buffer.from(slice).copy(frame);
      }
      this.outboundFrames.push(frame);
    }
    // No bounded silence tail is enqueued: once these speech frames drain, the pump
    // streams SILENCE_FRAMEs as the closing silence (see pumpTick) — what EL's server
    // VAD measures to close the turn — until the agent responds and the pump pauses.
  }

  async receiveAudio(timeout: number): Promise<AudioChunk> {
    if (!this.isConnected()) {
      throw new Error("ElevenLabsAgentAdapter: not connected");
    }

    const queued = this.audioQueue.shift();
    if (queued) return queued;

    return await new Promise<AudioChunk>((resolve, reject) => {
      // Forward-declared so the timers, the resetter, and the waiter share them.
      let timer: ReturnType<typeof setTimeout>;
      // Absolute wall-clock ceiling (the keepalive-ping backstop). Unlike `timer`,
      // this is set ONCE and NEVER reset by inbound frames, so endless keepalive
      // pings cannot push it out — it always fires after a fixed wall-clock bound
      // and unwedges a pings-but-no-audio receive. Sized as max(timeout, 45s): never
      // below the caller's own idle budget (so it does not pre-empt a legitimately
      // slow-but-responding agent), but at least 45s even for sub-second tail-probe
      // calls. In the real drain `timeout` is the 30s response budget or the 0.6s
      // tail probe, so the ceiling is 45s.
      // Must stay `let`: the cleanup() closure below captures hardTimer before
      // it is assigned, so declaration and assignment cannot be merged (const).
      // eslint-disable-next-line prefer-const
      let hardTimer: ReturnType<typeof setTimeout>;
      const hardCeilingMs = Math.max(timeout, KEEPALIVE_HARD_CEILING_S) * 1000;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(hardTimer);
        const timerIdx = this.timerResetters.indexOf(resetTimer);
        if (timerIdx >= 0) this.timerResetters.splice(timerIdx, 1);
        const waiterIdx = this.waiters.indexOf(waiter);
        if (waiterIdx >= 0) this.waiters.splice(waiterIdx, 1);
      };

      const onTimeout = () => {
        cleanup();
        reject(
          new Error(
            "ElevenLabsAgentAdapter: receiveAudio timed out (no agent audio " +
              "within the deadline — the hosted agent produced no audio, whether " +
              "fully silent or only keepalive-pinging). For a scripted multi-turn " +
              "run this usually means the agent ended or transferred its turn " +
              "(e.g. an escalation/handoff request), or the user turn did not " +
              "commit. See " +
              "https://scenario.langwatch.ai/voice/troubleshooting#receiveaudio-timed-out-hosted-elevenlabs",
          ),
        );
      };

      // Re-arm the IDLE deadline on every received message (pings included) so a
      // slow-but-healthy server that keeps pinging while processing does not trip
      // the timer. Matches the Python recv_audio sliding-idle-deadline. The hard
      // ceiling is deliberately NOT reset here.
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, timeout * 1000);
      };

      const waiter = (chunk: AudioChunk) => {
        cleanup();
        resolve(chunk);
      };

      timer = setTimeout(onTimeout, timeout * 1000);
      hardTimer = setTimeout(onTimeout, hardCeilingMs);
      this.timerResetters.push(resetTimer);
      this.waiters.push(waiter);
    });
  }

  /**
   * Synchronously drain every chunk currently buffered on {@link audioQueue} and
   * return them merged (null when the queue is empty). The turn-boundary
   * reconcile (#747) calls this at the moment a NEW user turn commits: at that
   * instant the queue can hold ONLY leftover from the PRIOR agent turn — the user
   * just spoke and the hosted agent has not begun its next reply, so any audio
   * still queued is stale-by-position. Returning it here lets the runtime
   * attribute it to the utterance that produced it instead of the next
   * {@link receiveAudio} shifting it out as the fake first audio of the next turn
   * (the split-utterance bleed). Called ONLY at the cursor-safe pre-user-sendAudio
   * hook and never while a drain is in flight, so it does not race
   * {@link receiveAudio} on the shared queue.
   *
   * Duck-typed convention (symmetric with {@link lastAgentTranscript}): the shared
   * runtime feature-detects this method, so adapters without a buffered queue are
   * untouched.
   */
  reconcilePendingAudio(): AudioChunk | null {
    if (this.audioQueue.length === 0) return null;
    const chunks = this.audioQueue.splice(0, this.audioQueue.length);
    const total = chunks.reduce((acc, c) => acc + c.data.length, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk.data, offset);
      offset += chunk.data.length;
    }
    return new AudioChunk({ data });
  }

  // ---------------------------------------------------------------- internals
  /**
   * Universal inbound-message hook — wired to the SDK's `callbackMessageReceived`,
   * which fires for EVERY message (ping, audio, transcript, …) AFTER the SDK has
   * routed it. Two jobs, both ours rather than the SDK's:
   *
   *  - LIVENESS: any inbound frame re-arms all active receiveAudio idle deadlines so
   *    a slow-but-pinging server does not spuriously time out (the sliding
   *    idle-deadline). The SDK already auto-pongs pings; we only need the reset.
   *  - TERMINAL TURN: a `client_tool_call` is a tool-only / non-audio terminal — this
   *    adapter ships no client_tool_result path, so EL produces no spoken audio for
   *    it. Resolve the parked receiver with an empty chunk so the drain exits cleanly
   *    instead of hanging to the timeout.
   *
   * Exposed via the class (not a closure) so unit tests can drive it directly.
   */
  onMessage(message: unknown): void {
    // Liveness reset first — every inbound frame counts.
    for (const resetter of this.timerResetters) resetter();

    const event = (message ?? {}) as Record<string, unknown>;
    const etype = (event.type as string | undefined) ?? "";

    if (etype === "client_tool_call") {
      // Active-waiters-only: if a receive is in flight, hand it the empty terminal;
      // otherwise DROP it (do not queue an empty sentinel that would surface as the
      // next turn's first receiveAudio result). The drain always parks a waiter
      // before the agent acts, so a mid-turn tool call finds one. Parity with the
      // close/error drain.
      const waiter = this.waiters.shift();
      if (waiter) waiter(new AudioChunk({ data: new Uint8Array(0) }));
      return;
    }

    if (etype === "conversation_initiation_metadata") {
      this.warnOnFormatDrift(event);
    }

    // `interruption`, `ping`, audio, transcripts, and unknown events are handled by
    // the SDK (and the dedicated callbacks); nothing else to do here.
  }

  /**
   * Warn if EL's negotiated audio format drifts from the pcm16/24000 we advertise
   * and stream — a pitch-shift / decode-failure early warning. Carries over the
   * prior adapter's drift check onto the SDK's metadata message.
   */
  private warnOnFormatDrift(event: Record<string, unknown>): void {
    const meta =
      (event.conversation_initiation_metadata_event as
        | Record<string, unknown>
        | undefined) ?? {};
    const outFmt = meta.agent_output_audio_format as string | undefined;
    const inFmt = meta.user_input_audio_format as string | undefined;
    if (outFmt && outFmt !== "pcm_24000") {
       
      console.warn(
        `ElevenLabsAgentAdapter: agent_output_audio_format=${outFmt} differs ` +
          `from advertised pcm16/24000 capability; audio may pitch-shift or fail to decode.`,
      );
    }
    if (inFmt && inFmt !== "pcm_24000") {
       
      console.warn(
        `ElevenLabsAgentAdapter: user_input_audio_format=${inFmt} differs ` +
          `from advertised pcm16/24000 capability; the agent may not understand audio we send.`,
      );
    }
  }
}

// ============================================================================
// ElevenLabsVoiceAgent — branded composable preset (local STT+LLM+TTS).
// ============================================================================

/**
 * Provider-specific signatures — `api_key` is required, every other knob is an
 * optional override with an EL-opinionated default.
 */
export interface ElevenLabsVoiceAgentOptions {
  apiKey: string;
  /** Override the default ai-sdk LanguageModel. Defaults to `openai("gpt-5.4-mini")`. */
  llm?: LanguageModel;
  /**
   * TTS voice string in `"elevenlabs/<voiceId>"` form. Defaults to the
   * `ELEVENLABS_VOICE_ID` env var when set, otherwise to
   * `elevenlabs/EXAVITQu4vr4xnSDxMaL` (Sarah).
   */
  voice?: string;
  /** Plug an alternate STT — defaults to {@link ElevenLabsSTTProvider}. */
  stt?: STTProvider;
  /** Override the system prompt. Defaults to {@link ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT}. */
  systemPrompt?: string;
  /** Test seam — forwarded to the underlying `synthesize` helper. */
  ttsOptions?: SynthesizeOptions;
}

/**
 * Composable voice agent with ElevenLabs-opinionated defaults.
 *
 * Not to be confused with {@link ElevenLabsAgentAdapter} (above) which talks to
 * ElevenLabs' **hosted** ConvAI endpoint. This class is **local**: you compose
 * `ElevenLabsSTTProvider` + any LLM + ElevenLabs TTS yourself.
 *
 * Default stack:
 *   - STT: {@link ElevenLabsSTTProvider} with the same API key.
 *   - LLM: `openai("gpt-5.4-mini")` — text-only chat completion.
 *   - TTS: `elevenlabs/EXAVITQu4vr4xnSDxMaL` (Sarah — free-tier premade).
 *     Override via the `ELEVENLABS_VOICE_ID` env var or the `voice` arg.
 *
 * @example
 * ```ts
 * // Defaults — all ElevenLabs STT, gpt-5.4-mini, EL TTS
 * const apiKey = process.env.ELEVENLABS_API_KEY;
 * if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required");
 * const agent = new ElevenLabsVoiceAgent({ apiKey });
 *
 * // Override just the LLM
 * import { anthropic } from "@ai-sdk/anthropic";
 * const agent = new ElevenLabsVoiceAgent({ apiKey, llm: anthropic("claude-sonnet-4-6") });
 *
 * // Bring your own STT
 * const agent = new ElevenLabsVoiceAgent({ apiKey, stt: new MyCustomSTT() });
 * ```
 */
export class ElevenLabsVoiceAgent extends ComposableVoiceAgent {
  readonly voice: string;

  constructor(options: ElevenLabsVoiceAgentOptions) {
    const voice = options.voice ?? resolveDefaultVoice();
    const stt = options.stt ?? new ElevenLabsSTTProvider({ apiKey: options.apiKey });
    const llm = options.llm ?? openai(COMPOSABLE_VOICE_LLM_MODEL);
    const ttsOptions: SynthesizeOptions = {
      apiKey: options.apiKey,
      ...options.ttsOptions,
    };

    super({
      stt,
      llm,
      tts: voice,
      systemPrompt: options.systemPrompt,
      ttsOptions,
    });

    this.voice = voice;
  }

  override toString(): string {
    return `ElevenLabsVoiceAgent(apiKey='***', llm=<LanguageModel>, voice='${this.voice}')`;
  }
}

function resolveDefaultVoice(): string {
  const envVoice = process.env.ELEVENLABS_VOICE_ID;
  if (envVoice) return `elevenlabs/${envVoice}`;
  return `elevenlabs/${ELEVENLABS_DEFAULT_VOICE_ID}`;
}
