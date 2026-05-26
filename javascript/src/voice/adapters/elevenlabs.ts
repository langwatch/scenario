/**
 * ElevenLabsAgentAdapter — hosted ElevenLabs Conversational AI.
 *
 * TypeScript port of `python/scenario/voice/adapters/elevenlabs.py`.
 *
 * Connects to ElevenLabs' hosted endpoint where the STT→LLM→TTS loop runs
 * on their infrastructure. All audio is PCM16 @ 24 kHz mono — no
 * conversion needed at either edge.
 *
 * Not to be confused with {@link ElevenLabsVoiceAgent} (in
 * `./eleven-labs-voice-agent`) which is the typed composable preset that
 * runs locally with separate STT, LLM, and TTS providers.
 *
 * Wire protocol:
 *  - Send: JSON `{"user_audio_chunk": "<base64 PCM16>"}`
 *  - Recv events:
 *    - `conversation_initiation_metadata` — audio-format drift warning
 *    - `user_transcript` / `agent_response` — observability fields
 *    - `agent_response_correction` — post-barge-in correction replaces
 *      `lastAgentTranscript`
 *    - `audio` — decoded base64 PCM16 and returned from `receiveAudio`
 *    - `ping` — replied with `{"type": "pong", "event_id": <id>}`
 *    - `interruption` — swallowed
 *    - Anything else — silently skipped
 */
import { Buffer } from "node:buffer";

import WebSocket, { type RawData } from "ws";

import { AgentRole } from "../../domain/agents";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { VoiceAgentAdapter } from "../adapter";

export const ELEVENLABS_CONVAI_URL_TEMPLATE =
  "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}";

/**
 * Empirical tail: EL ConvAI stops responding to subsequent turns unless the
 * client signals end-of-turn via silence padding. 16000 zero bytes at 24 kHz
 * = ~333 ms silence — reliable middle ground between "no tail" (greeting only)
 * and "double tail" (mid-conversation stalls). See Python adapter docstring.
 */
const SILENCE_TAIL_BYTES = 16000;

export interface ElevenLabsAgentAdapterOptions {
  /** ID of the ElevenLabs Conversational AI agent (provisioned in the EL dashboard). */
  agentId: string;
  /** ElevenLabs API key (`xi-api-key`). */
  apiKey: string;
  /**
   * Per-session system prompt override applied via
   * `conversation_initiation_client_data`. Lets demos use a different prompt
   * shape without mutating the shared test agent.
   */
  systemPromptOverride?: string;
  /** Per-session first message override. */
  firstMessageOverride?: string;
  /**
   * WebSocket factory — injected for tests. Defaults to the `ws` package's
   * `WebSocket` constructor. Production callers should leave this unset.
   */
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
}

/**
 * Minimal subset of the `ws` library's WebSocket surface that the adapter
 * actually uses. Exists so tests can inject a fake without pulling in `ws`.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "open", listener: () => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  removeAllListeners(): void;
  readyState?: number;
}

/**
 * Hosted ElevenLabs Conversational AI adapter.
 *
 * Connect, send PCM16 audio chunks, and drain agent audio over the
 * `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...` socket.
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
  private readonly webSocketFactory: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocketLike;

  private ws: WebSocketLike | null = null;
  /** Queue of pending audio chunks already decoded from the wire. */
  private readonly audioQueue: AudioChunk[] = [];
  /** Resolvers waiting on the next audio chunk (FIFO). */
  private readonly waiters: Array<(chunk: AudioChunk) => void> = [];

  lastUserTranscript: string | null = null;
  lastAgentTranscript: string | null = null;

  constructor(options: ElevenLabsAgentAdapterOptions) {
    super();
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.systemPromptOverride = options.systemPromptOverride;
    this.firstMessageOverride = options.firstMessageOverride;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike);
  }

  /** ConvAI URL templated with this adapter's `agentId`. */
  get url(): string {
    return ELEVENLABS_CONVAI_URL_TEMPLATE.replace("{agent_id}", this.agentId);
  }

  /** Hides the API key. */
  override toString(): string {
    return `ElevenLabsAgentAdapter(agentId='${this.agentId}', apiKey='***')`;
  }

  // --------------------------------------------------------------- AgentAdapter
  async call(): Promise<string> {
    // PR1 contract surface — the executor-driven `call()` lands in PR3
    // (#515). Keeping it as a stub so the adapter is constructible and the
    // hosted demo's scenario.run() can wire connect/send/recv directly via
    // the runtime once it lands. Returning a deterministic stub keeps unit
    // tests focused on the adapter's I/O surface.
    return "ElevenLabsAgentAdapter";
  }

  // ---------------------------------------------------------------- lifecycle
  async connect(): Promise<void> {
    const ws = this.webSocketFactory(this.url, { "xi-api-key": this.apiKey });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeAllListeners();
        // Re-attach the post-open listeners atomically. `error` + `close` are
        // load-bearing: an unhandled `error` on a Node EventEmitter crashes
        // the process. The `error` handler null's `this.ws` so subsequent
        // `sendAudio`/`receiveAudio` calls fail fast with a clear message
        // instead of writing to a dead socket.
        ws.on("message", (data) => this.onMessage(data));
        ws.on("error", (err: Error) => this.onSocketError(err));
        ws.on("close", () => this.onSocketClose());
        resolve();
      };
      const onError = (err: Error) => {
        ws.removeAllListeners();
        this.ws = null;
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    const agentOverride: Record<string, unknown> = {};
    if (this.systemPromptOverride) {
      agentOverride.prompt = { prompt: this.systemPromptOverride };
    }
    if (this.firstMessageOverride) {
      agentOverride.first_message = this.firstMessageOverride;
    }

    ws.send(
      JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_config_override: { agent: agentOverride },
      }),
    );
  }

  /** Called when the post-open socket emits an `error`. */
  private onSocketError(err: Error): void {
    // eslint-disable-next-line no-console
    console.warn(`ElevenLabsAgentAdapter: socket error after open: ${err.message}`);
    // Resolve pending waiters with an empty chunk so the executor unwinds
    // rather than hanging on a dead socket.
    this.drainPendingWaiters();
    this.ws = null;
  }

  /** Called when the socket closes. */
  private onSocketClose(): void {
    this.drainPendingWaiters();
    this.ws = null;
  }

  private drainPendingWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(new AudioChunk({ data: new Uint8Array(0) }));
    }
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // Best-effort: a half-closed socket can throw on close. We're tearing
      // down regardless — swallowing here matches the Python behavior.
    }
    this.ws = null;
    this.drainPendingWaiters();
  }

  // ---------------------------------------------------------------- I/O
  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (!this.ws) {
      throw new Error("ElevenLabsAgentAdapter: not connected");
    }

    // 1. Speech.
    const speechB64 = Buffer.from(chunk.data).toString("base64");
    this.ws.send(JSON.stringify({ user_audio_chunk: speechB64 }));

    // 2. Silence tail — see SILENCE_TAIL_BYTES doc for sizing rationale.
    const silence = new Uint8Array(SILENCE_TAIL_BYTES);
    const silenceB64 = Buffer.from(silence).toString("base64");
    this.ws.send(JSON.stringify({ user_audio_chunk: silenceB64 }));
  }

  async receiveAudio(timeout: number): Promise<AudioChunk> {
    if (!this.ws) {
      throw new Error("ElevenLabsAgentAdapter: not connected");
    }

    const queued = this.audioQueue.shift();
    if (queued) return queued;

    return await new Promise<AudioChunk>((resolve, reject) => {
      // Forward-declared so both the timer and the waiter can close over it.
      let timer: ReturnType<typeof setTimeout>;
      const waiter = (chunk: AudioChunk) => {
        clearTimeout(timer);
        resolve(chunk);
      };
      timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("ElevenLabsAgentAdapter: receiveAudio timed out"));
      }, timeout * 1000);
      this.waiters.push(waiter);
    });
  }

  // ---------------------------------------------------------------- internals
  /** Handle one inbound WS frame. Exported via class for unit-test injection. */
  onMessage(data: RawData): void {
    const raw = data instanceof Buffer ? data.toString("utf-8") : String(data);
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const etype = (event.type as string | undefined) ?? "";
    if (etype === "audio") {
      const audioEvent = (event.audio_event as Record<string, unknown> | undefined) ?? {};
      const b64 = (audioEvent.audio_base_64 as string | undefined) ?? "";
      let pcm = Buffer.from(b64, "base64");
      if (pcm.length % 2 === 1) pcm = pcm.subarray(0, pcm.length - 1);
      const chunk = new AudioChunk({ data: new Uint8Array(pcm) });
      const waiter = this.waiters.shift();
      if (waiter) waiter(chunk);
      else this.audioQueue.push(chunk);
      return;
    }

    if (etype === "ping") {
      const pingEvent = (event.ping_event as Record<string, unknown> | undefined) ?? {};
      const eventId = pingEvent.event_id ?? event.event_id;
      if (eventId === undefined || eventId === null) return;
      this.ws?.send(JSON.stringify({ type: "pong", event_id: eventId }));
      return;
    }

    if (etype === "user_transcript") {
      const userEvent =
        (event.user_transcription_event as Record<string, unknown> | undefined) ?? {};
      this.lastUserTranscript = (userEvent.user_transcript as string | undefined) ?? null;
      return;
    }

    if (etype === "agent_response") {
      const agentEvent =
        (event.agent_response_event as Record<string, unknown> | undefined) ?? {};
      this.lastAgentTranscript = (agentEvent.agent_response as string | undefined) ?? null;
      return;
    }

    if (etype === "agent_response_correction") {
      const correction =
        (event.agent_response_correction_event as Record<string, unknown> | undefined) ?? {};
      const corrected = correction.corrected_agent_response as string | undefined;
      if (corrected) this.lastAgentTranscript = corrected;
      return;
    }

    if (etype === "conversation_initiation_metadata") {
      const meta =
        (event.conversation_initiation_metadata_event as
          | Record<string, unknown>
          | undefined) ?? {};
      const outFmt = meta.agent_output_audio_format as string | undefined;
      const inFmt = meta.user_input_audio_format as string | undefined;
      if (outFmt && outFmt !== "pcm_24000") {
        // eslint-disable-next-line no-console
        console.warn(
          `ElevenLabsAgentAdapter: agent_output_audio_format=${outFmt} differs ` +
            `from advertised pcm16/24000 capability; audio may pitch-shift or fail to decode.`,
        );
      }
      if (inFmt && inFmt !== "pcm_24000") {
        // eslint-disable-next-line no-console
        console.warn(
          `ElevenLabsAgentAdapter: user_input_audio_format=${inFmt} differs ` +
            `from advertised pcm16/24000 capability; the agent may not understand audio we send.`,
        );
      }
      return;
    }

    // `interruption` and any unknown events are swallowed — Python parity.
  }
}
