/**
 * TwilioAgentAdapter — bidirectional real-phone transport via Twilio Media
 * Streams. TypeScript port of `python/scenario/voice/adapters/twilio.py`.
 *
 * One adapter class serves both directions a Twilio number can participate in:
 *
 * - **Inbound** — `waitForCall()` sets the number's voice webhook to our
 *   local server, blocks until a caller dials in, and opens a Media Streams
 *   WebSocket for the call.
 * - **Outbound** — `placeCall({ to })` originates a call via Twilio REST,
 *   then accepts the Media Streams WebSocket Twilio opens back to us.
 *
 * `connect()` is direction-agnostic: resolve the number SID, start the HTTP +
 * WS server, expose it via a public URL (caller-supplied or via a tunnel).
 * After `connect()`, call either `placeCall()` or `waitForCall()`.
 *
 * Wire protocol: Twilio Media Streams JSON over WebSocket. Frame parsing +
 * codec live in `./twilio-shared.ts`.
 */

import { AgentRole } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { currentSpan, setSpanAttributes, voiceSpan } from "../telemetry";
import { sleep } from "../utils";

import { twilioLogger } from "./twilio-logger";
import { TwilioWebhookServer, type MediaStreamWebSocket } from "./twilio-server";
import {
  TWILIO_FRAME_MS,
  TunnelNotReadyError,
  type TunnelReadiness,
  TwilioRESTHelper,
  buildClearFrame,
  buildMediaFrame,
  escapeXmlAttr,
  iterMulawFrames,
  mintStreamNonce,
  normalizeE164,
  pcm16_24kToMulaw8k,
  redactE164,
  resolveMaxCallDuration,
  streamWsUrl,
  validateE164,
} from "./twilio-shared";

export { TunnelNotReadyError, type TunnelReadiness } from "./twilio-shared";

export type TwilioAdapterMode = "idle" | "answer" | "call";

/** How the media-stream session most recently ended. "none" until a session
 * has ever run (the disconnect-counters T3 enum, #775). Set by
 * {@link TwilioWebhookServer.mediaStreamLoop} at each of its three
 * termination paths. `"max_duration"` is the a-leg duration cap firing (#762
 * guardrail (b)) — kept distinct from `"close"` so a scenario author can tell
 * "we hung the call up at the cap" from "the callee hung up". */
export type TwilioStreamEndedReason = "stop" | "close" | "error" | "none" | "max_duration";

const PLACE_CALL_A_LEG_SAY_TEXT =
  "Thank you for calling. " +
  "I will hold the line while you complete your scenario.";

/**
 * Refusal for `sendDtmf` under a-leg (#762 AC10). Says WHY, because
 * "unsupported" alone reads as an oversight rather than a deliberate guard.
 */
export const A_LEG_SEND_DTMF_UNSUPPORTED =
  "TwilioAgentAdapter: sendDtmf is unsupported in external (a-leg) mode. " +
  "Sending DTMF replaces the live call's TwiML, which redirects the call away " +
  "from the <Connect><Stream> verb and would end the media stream this " +
  "scenario is running on. In b-leg mode the stream rides the callee's leg, " +
  "so the redirect is harmless; in a-leg mode it is the call. Use b-leg mode " +
  "(an owned callee number) if the scenario needs DTMF.";

/** Effective stream-attach mode resolved from `placeCall`'s two parameters. */
type StreamAttachMode = "a-leg" | "b-leg" | "originator-only";

/**
 * Resolve the effective `placeCall` stream-attach mode.
 *
 * `attachStream` (typed) supersedes the legacy `attachStreamToSelf` bool. If
 * `attachStream` is given, it wins; if the bool is ALSO explicitly given and
 * disagrees ("a-leg" with `true`, or "b-leg" with `false`), that's a caller
 * error. With `attachStream` unset: `false` selects the originator-only third
 * mode (which `attachStream` cannot express), `true`/unset selects "b-leg".
 */
function resolveStreamMode(
  attachStream: "a-leg" | "b-leg" | undefined,
  attachStreamToSelf: boolean | undefined,
): StreamAttachMode {
  if (attachStream !== undefined) {
    if (
      attachStreamToSelf !== undefined &&
      ((attachStream === "a-leg" && attachStreamToSelf === true) ||
        (attachStream === "b-leg" && attachStreamToSelf === false))
    ) {
      throw new Error(
        `placeCall: attachStream=${JSON.stringify(attachStream)} conflicts with ` +
          `attachStreamToSelf=${JSON.stringify(attachStreamToSelf)}; pass only one.`,
      );
    }
    return attachStream;
  }
  if (attachStreamToSelf === false) return "originator-only";
  return "b-leg";
}

/**
 * Build inline `<Connect><Stream>` origination TwiML for a-leg mode.
 *
 * `streamParameters` renders `<Parameter name=.. value=../>` children inside
 * `<Stream>`; an empty record renders the self-closing `<Stream url=".."/>`
 * form byte-identically to the inbound webhook's TwiML.
 */
function buildConnectStreamTwiml(
  wsUrl: string,
  streamParameters: Record<string, string>,
): string {
  const paramChildren = Object.entries(streamParameters)
    .map(
      ([name, value]) =>
        `<Parameter name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}"/>`,
    )
    .join("");
  const streamEl = paramChildren
    ? `<Stream url="${escapeXmlAttr(wsUrl)}">${paramChildren}</Stream>`
    : `<Stream url="${escapeXmlAttr(wsUrl)}"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>${streamEl}</Connect>` +
    `</Response>`
  );
}

export interface TwilioAgentAdapterOptions {
  accountSid: string;
  authToken: string;
  /** Twilio-owned phone number in E.164 format (e.g. "+14155551234"). */
  phoneNumber: string;
  /** HTTPS URL routing to this machine. Required at `connect()` time. */
  publicBaseUrl?: string;
  /** Allowed-callers filter for inbound calls. Unset = any caller accepted. */
  allowedCallers?: readonly string[];
  /**
   * Destination allowlist for a-leg outbound calls (#762 guardrail (c)).
   * Unset denies EVERY a-leg destination: a-leg dials numbers this account does
   * not own, so an unguarded `to` is an unbounded dialer and the capability has
   * to be opted into per destination. Entries are validated at construction, so
   * a typo fails at setup instead of when a PSTN call is about to be billed.
   * b-leg is deliberately not gated on this — it can only reach numbers on this
   * account, which is its own guardrail.
   */
  allowedCallees?: readonly string[];
  /**
   * Edge-readiness probe consulted before a-leg origination (#762 guardrail
   * (c)). Unset means the caller owns a stable public URL and has nothing to
   * wait for.
   */
  tunnelReadiness?: TunnelReadiness;
  /** Callback invoked when the remote side sends DTMF mid-call. */
  onDtmf?: (digit: string) => void;
  /** HTTP server port. 0 = OS-assigned (recommended for tests). */
  httpPort?: number;
  /** Role under test — `AGENT` (default) or `USER`. */
  role?: AgentRole;
  /**
   * Reject inbound webhooks without a valid `X-Twilio-Signature`. Tests pass
   * `false` to bypass; production callers must leave on.
   */
  validateSignature?: boolean;
  /**
   * Optional `fetch` override for the REST client. Tests pass an in-memory
   * mock so unit tests can verify REST traffic without real Twilio.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional REST helper override. When provided, replaces the default
   * `TwilioRESTHelper` constructed from `accountSid`/`authToken`. Lets tests
   * inject a fully-stubbed REST surface.
   */
  rest?: TwilioRESTHelper;
}

export class TwilioAgentAdapter extends VoiceAgentAdapter {
  readonly capabilities: AdapterCapabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: false,
    dtmf: true,
    // Twilio Media Streams `clear` event drops all buffered outbound audio.
    // Used by `interrupt()` below.
    interruption: true,
    inputFormats: ["mulaw/8000"],
    outputFormats: ["mulaw/8000"],
  });

  readonly accountSid: string;
  readonly authToken: string;
  readonly phoneNumber: string;
  publicBaseUrl?: string;
  readonly allowedCallers?: ReadonlySet<string>;
  readonly allowedCallees?: ReadonlySet<string>;
  readonly tunnelReadiness?: TunnelReadiness;
  readonly onDtmf?: (digit: string) => void;
  readonly httpPort: number;
  readonly validateSignature: boolean;
  readonly fetchImpl: typeof fetch;

  override role: AgentRole;

  private _rest: TwilioRESTHelper | null;
  private _phoneNumberSid?: string;
  private _priorVoiceUrl?: string;
  private _calleePhoneNumberSid?: string;
  private _priorCalleeVoiceUrl?: string;
  private _mode: TwilioAdapterMode = "idle";
  private _webhookServer: TwilioWebhookServer | null = null;
  private _streamSid?: string;
  private _callSid?: string;
  private _streamWs: MediaStreamWebSocket | null = null;
  /**
   * A-leg WS auth (#762 guardrail (a)). Set by `placeCall` in "a-leg" mode only;
   * its non-undefined-ness is what ARMS media-stream nonce enforcement. In b-leg
   * mode the signed `POST /twilio/voice` precedes the socket, so the socket
   * inherits that trust and this stays undefined — enforcement is keyed on the
   * mode we originated in, never on whether the inbound frame happens to carry a
   * nonce (which an attacker could simply omit).
   */
  private _streamNonce?: string;
  /**
   * Adapter-side max-call-duration watchdog (#762 guardrail (b)). Armed by
   * `placeCall` in "a-leg" mode; the belt to Twilio's own `TimeLimit`
   * suspenders, which is the half that survives this process dying. The
   * generation counter is the cancel token: every arm and every cancel bumps
   * it, so an expiry that belongs to a superseded call is dropped instead of
   * hanging up whatever call is live now.
   */
  private _maxDurationGeneration = 0;
  private _maxDurationTimeout: ReturnType<typeof setTimeout> | null = null;
  private _streamConnected = makeDeferred<void>();
  private _inboundQueue: InboundQueue = new InboundQueue();
  private _connected = false;
  // Set true by the media-stream loop's terminal path (stop / socket close /
  // throw) the moment it enqueues the end-of-call sentinel. Once the call has
  // ended, receiveAudio must keep draining the queue (and hand back the
  // sentinel) WITHOUT re-asserting transport liveness — `_handleStreamSocket`
  // nulls `_streamWs`/`_streamSid` synchronously right after the loop returns,
  // so the drain's second receiveAudio would otherwise hit `_assertStreamLive`
  // and throw "no live media stream" (#695). Reset on connect(), disconnect(),
  // and at media-stream-loop entry (per-call scope — a second session on the
  // same connected adapter must not inherit the previous session's flag).
  private _streamEnded = false;
  // Call-lifetime counters stamped onto `voice.adapter.disconnect` from inside
  // disconnect() (#775 Tier 2b — mirrors ElevenLabs' pump-counter seam).
  // Accumulated by the media loop (twilio-server.ts) and the `/twilio/voice`
  // webhook handler; reset on connect()/disconnect() like `_streamEnded`
  // above. `webhook_rejected` reuses the pre-existing `rejectedCount` field
  // (below) rather than duplicating it.
  private _framesReceived = 0;
  private _dtmfReceived = 0;
  private _streamEndedReason: TwilioStreamEndedReason = "none";
  private _webhookInvocations = 0;

  constructor(options: TwilioAgentAdapterOptions) {
    super();
    validateE164(options.phoneNumber);
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.phoneNumber = options.phoneNumber;
    this.publicBaseUrl = options.publicBaseUrl;
    this.allowedCallers = options.allowedCallers
      ? new Set(options.allowedCallers)
      : undefined;
    // Normalising here is also validating: a bad entry throws at construction
    // rather than at dial time. See `allowedCallees` on the options type.
    this.allowedCallees = options.allowedCallees?.length
      ? new Set(options.allowedCallees.map(normalizeE164))
      : undefined;
    this.tunnelReadiness = options.tunnelReadiness;
    this.onDtmf = options.onDtmf;
    this.httpPort = options.httpPort ?? 0;
    this.role = options.role ?? AgentRole.AGENT;
    this.validateSignature = options.validateSignature ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this._rest = options.rest ?? null;
  }

  // call() is inherited from VoiceAgentAdapter (defaultVoiceCall) — the executor
  // drives the Media Streams audio loop (Gap #11). No leaf-level override.

  // ------------------------------------------------------------------ lifecycle

  async connect(): Promise<void> {
    if (this._connected) return; // idempotent
    if (!this.publicBaseUrl) {
      throw new Error(
        "TwilioAgentAdapter: publicBaseUrl is required. Wrap the adapter in a " +
          "TwilioTunnel or supply a stable public HTTPS URL routing to this machine.",
      );
    }

    if (!this._rest) {
      this._rest = new TwilioRESTHelper(this.accountSid, this.authToken, this.fetchImpl);
    }
    this._phoneNumberSid = await this._rest.resolvePhoneNumberSid(this.phoneNumber);

    // Stamp Twilio-specific attrs onto the active `voice.adapter.connect` span
    // (opened by `startVoiceAdapters`). Base spans are name-owned; the adapter
    // contributes attributes, never a parallel span name — mirror ElevenLabs'
    // `voice.elevenlabs.agent_id` seam (`adapters/elevenlabs.ts`).
    // NOTE: no `voice.twilio.direction` here — connect() is direction-agnostic
    // (`_mode` stays "idle" until placeCall()/waitForCall(), after this span
    // has already closed); direction is stamped on the NEW
    // `voice.adapter.dial` span instead (see placeCall/waitForCall).
    setSpanAttributes(currentSpan(), {
      "voice.twilio.phone_number_sid": this._phoneNumberSid,
      "voice.twilio.validate_signature": this.validateSignature,
      "voice.twilio.webhook_port": this.httpPort,
    });

    this._mode = "idle";
    this._streamNonce = undefined;
    this._cancelMaxDurationTimer();
    this._streamConnected = makeDeferred<void>();
    this._inboundQueue.reset();
    this._streamEnded = false;
    this._framesReceived = 0;
    this._dtmfReceived = 0;
    this._streamEndedReason = "none";
    this._webhookInvocations = 0;
    // MUST-FIX (#775 review): reset alongside the other Tier-2b counters so a
    // reconnect on the same instance doesn't leak the previous session's
    // rejected count (see the matching reset in disconnect()).
    this.rejectedCount = 0;

    this._webhookServer = new TwilioWebhookServer(this);
    await this._webhookServer.start();
    this._connected = true;
  }

  /** Whether the Media Stream transport is open (Gap #11). */
  override isConnected(): boolean {
    return this._connected;
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;

    // Restore prior voice_url (answer mode only). `restRestoreFailed` tracks
    // whether either restore below threw — previously fully swallowed; now
    // surfaced onto the disconnect span (#775 Tier 2b) so a Twilio REST
    // outage during teardown is no longer invisible. The swallow behavior
    // itself (a failed restore must never block disconnect()) is unchanged.
    // Disarm the duration watchdog first: from here on the call is ours to
    // end, and a timer that fired mid-teardown would hang up a SID this adapter
    // may already have replaced with a later call's.
    this._cancelMaxDurationTimer();

    let restRestoreFailed = false;
    if (this._mode === "answer" && this._phoneNumberSid && this._rest) {
      try {
        await this._rest.writeVoiceUrl(this._phoneNumberSid, this._priorVoiceUrl ?? "");
      } catch {
        restRestoreFailed = true;
      }
    }
    if (this._mode === "call" && this._calleePhoneNumberSid && this._rest) {
      try {
        await this._rest.writeVoiceUrl(
          this._calleePhoneNumberSid,
          this._priorCalleeVoiceUrl ?? "",
        );
      } catch {
        restRestoreFailed = true;
      }
    }

    // Tear the server down FIRST. This is what ACTUALLY closes a still-live
    // media stream (`stop()` closes every open `wss` client), which is what
    // lets `mediaStreamLoop`'s catch/terminal branches (twilio-server.ts)
    // make their FINAL writes to `_framesReceived` / `_streamEndedReason` /
    // etc. The counter stamp below MUST run after this await, not before —
    // stamping first (the #775 review-caught bug) reads the pre-teardown
    // snapshot and reports `stream_ended_reason=="none"` / undercounted
    // frames for a call that was still live when disconnect() was invoked,
    // even though the call did in fact end (via this very shutdown) moments
    // later.
    if (this._webhookServer) {
      await this._webhookServer.stop();
    }

    // Stamp call-lifetime counters onto the active `voice.adapter.disconnect`
    // span (opened by `stopVoiceAdapters`) — mirrors ElevenLabs' pump-counter
    // stamp (`adapters/elevenlabs.ts`). Sampled AFTER the shutdown-await above
    // (not before) so a still-live call's FINAL counts/reason are captured,
    // not a mid-call snapshot. The disconnect span stays the active span
    // across the await (AsyncLocalStorage context survives awaits), so
    // `currentSpan()` here still targets it.
    setSpanAttributes(currentSpan(), {
      "voice.twilio.frames_received": this._framesReceived,
      "voice.twilio.dtmf_received": this._dtmfReceived,
      "voice.twilio.stream_ended_reason": this._streamEndedReason,
      "voice.twilio.webhook_invocations": this._webhookInvocations,
      "voice.twilio.webhook_rejected": this.rejectedCount,
      "voice.twilio.rest_restore_failed": restRestoreFailed,
    });

    this._connected = false;
    this._webhookServer = null;
    this._rest = null;
    this._phoneNumberSid = undefined;
    this._priorVoiceUrl = undefined;
    this._calleePhoneNumberSid = undefined;
    this._priorCalleeVoiceUrl = undefined;
    this._mode = "idle";
    this._streamSid = undefined;
    this._callSid = undefined;
    this._streamWs = null;
    this._streamNonce = undefined;
    this._cancelMaxDurationTimer();
    this._streamConnected = makeDeferred<void>();
    this._inboundQueue.reset();
    this._streamEnded = false;
    this._framesReceived = 0;
    this._dtmfReceived = 0;
    this._streamEndedReason = "none";
    this._webhookInvocations = 0;
    // MUST-FIX (#775 review): every other Tier-2b counter resets on both
    // connect() and disconnect() — this pre-existing field didn't, so a
    // reconnect on the same instance leaked the previous session's rejected
    // count into the new session's disconnect span.
    this.rejectedCount = 0;
  }

  // ------------------------------------------------------------------ direction

  async placeCall(args: {
    to: string;
    timeoutMs?: number;
    /**
     * Legacy stream-attach toggle. Superseded by `attachStream`: `true`/unset →
     * "b-leg", `false` → originator-only. Passing both with disagreeing intent
     * throws.
     */
    attachStreamToSelf?: boolean;
    /**
     * Stream-attach mode. "b-leg" (default) rewrites the callee's voice_url —
     * owned numbers only. "a-leg" originates with inline `<Connect><Stream>` so
     * the stream rides our own leg and `to` can be any external number. Because
     * that reaches numbers this account does not own, `to` must appear in the
     * adapter's `allowedCallees` (deny-by-default) and the public base URL must
     * be reachable from the edge — both checked before origination.
     */
    attachStream?: "a-leg" | "b-leg";
    /**
     * How long the CALL may live, in seconds (a-leg only; default
     * {@link DEFAULT_MAX_CALL_DURATION_SECONDS}, hard cap
     * {@link MAX_CALL_DURATION_CAP_SECONDS} — a larger request throws).
     *
     * Not to be confused with `timeoutMs`, which bounds how long we WAIT FOR
     * THE MEDIA STREAM TO CONNECT and says nothing about the call's length.
     * Under a-leg's `<Connect>` the call lives exactly as long as the
     * WebSocket, so without a ceiling a hung executor keeps a billing PSTN call
     * open forever. Two mechanisms enforce it: Twilio's own `TimeLimit` on
     * `Calls.create` (the load-bearing half — it still fires if this process
     * hangs or is killed) and an adapter-side wall-clock timer that hangs the
     * call up via REST and closes the socket.
     */
    maxCallDurationSeconds?: number;
  }): Promise<void> {
    this._assertConnected();
    const rest = this._rest;
    const publicBaseUrl = this.publicBaseUrl;
    if (!rest || publicBaseUrl === undefined) {
      throw new Error("TwilioAgentAdapter: not connected");
    }
    this._enterMode("call");
    validateE164(args.to);

    // Resolve the effective stream-attach mode BEFORE any REST call so a
    // conflicting-parameter caller error surfaces before we dial.
    const mode = resolveStreamMode(args.attachStream, args.attachStreamToSelf);
    const timeoutMs = args.timeoutMs ?? 120_000;
    // Only a-leg loses <Pause>'s implicit ceiling, so only a-leg carries a
    // duration cap. Naming one in another mode is rejected rather than ignored:
    // silently dropping it would leave the caller believing the call is bounded
    // when it is not.
    let maxCallDuration: number | undefined;
    if (mode === "a-leg") {
      // Guardrail (c): destinations are deny-by-default in a-leg mode. Checked
      // here, with the other local caller-fixable failures, so a misconfigured
      // allowlist costs nothing and dials nothing.
      this._assertCalleeAllowed(args.to);
      maxCallDuration = resolveMaxCallDuration(args.maxCallDurationSeconds);
    } else if (args.maxCallDurationSeconds !== undefined) {
      throw new Error(
        `placeCall: maxCallDurationSeconds is only supported with ` +
          `attachStream="a-leg"; b-leg and originator-only modes hold the ` +
          `originator leg with <Pause> and are bounded by it.`,
      );
    }

    // Guardrail (c), second half: a-leg hands Twilio our public URL and Twilio
    // opens the media socket against it seconds later. Probe the edge AFTER the
    // free local checks above and BEFORE origination, so an unreachable tunnel
    // is a named error instead of a billed call that dies in a stream-connect
    // timeout.
    if (mode === "a-leg") {
      await this._assertTunnelReady();
    }

    // NEW `voice.adapter.dial` span (#775 Tier 2a): self-instrumented, since
    // no executor span is active by the time placeCall()/waitForCall() run
    // (the `voice.adapter.connect` span already closed). Wraps the REST dial
    // + the stream-connected wait — the "I placed the call but no media ever
    // streamed" failure surface.
    await voiceSpan(
      "voice.adapter.dial",
      {
        "voice.adapter.class": this.constructor.name,
        "voice.twilio.direction": "outbound",
        "voice.twilio.to": redactE164(args.to),
        "voice.twilio.from": redactE164(this.phoneNumber),
      },
      async (span) => {
        if (mode === "b-leg") {
          this._calleePhoneNumberSid = await rest.resolvePhoneNumberSid(args.to);
          this._priorCalleeVoiceUrl =
            (await rest.readVoiceUrl(this._calleePhoneNumberSid)) ?? undefined;
          const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/twilio/voice`;
          await rest.writeVoiceUrl(this._calleePhoneNumberSid, webhookUrl);
        }

        // a-leg: the Media Stream rides OUR own leg via inline
        // <Connect><Stream>, so `to` can be any external number and we touch
        // nothing on the callee. Same TwiML shape the inbound webhook returns
        // (twilio-server.ts), now on origination.
        //
        // Guardrail (a): the socket is the only inbound signal on this path, so
        // it must authenticate itself. Mint a per-call CSPRNG nonce and ship it
        // as a <Parameter> child; Twilio echoes it back in the `start` frame's
        // customParameters, and the media loop (twilio-server.ts) closes any
        // socket that cannot present it.
        //
        // Other modes: play a short deterministic <Say> anchor (Whisper
        // hallucinates on bare <Pause> silence, #465), then hold the bridge open
        // while B's webhook attaches the Media Stream.
        const nonce = mode === "a-leg" ? mintStreamNonce() : undefined;
        this._streamNonce = nonce;
        const originationTwiml =
          nonce !== undefined
            ? buildConnectStreamTwiml(streamWsUrl(publicBaseUrl), { nonce })
            : `<?xml version="1.0" encoding="UTF-8"?>` +
              `<Response>` +
              `<Say voice="Polly.Joanna">${PLACE_CALL_A_LEG_SAY_TEXT}</Say>` +
              `<Pause length="120"/>` +
              `</Response>`;
        this._callSid = await rest.placeCall({
          to: args.to,
          from: this.phoneNumber,
          twiml: originationTwiml,
          timeLimitSeconds: maxCallDuration,
        });
        setSpanAttributes(span, { "voice.twilio.call_sid": this._callSid });

        if (maxCallDuration !== undefined) {
          this._armMaxDurationTimer(maxCallDuration, this._callSid, args.to);
        }

        if (mode !== "originator-only") {
          // Wait for the media stream to reach us — via the callee's rewritten
          // voice_url (b-leg) or our own <Connect><Stream> leg (a-leg). In
          // originator-only mode no stream comes to us; the callee owns it.
          const dialWaitStarted = performance.now(); // monotonic
          try {
            await this._streamConnected.promiseWithTimeout(timeoutMs);
          } catch (err) {
            // The media stream never connected — the marquee "I placed the
            // call but no media ever streamed" failure. Tag the outcome
            // BEFORE re-throwing ONLY when it's genuinely the timeout
            // (matches Python's `except asyncio.TimeoutError` scoping — a
            // non-timeout rejection of the deferred must not be mislabeled).
            // The re-thrown error still marks the span ERROR either way
            // (voiceSpan's own exception handling).
            if (err instanceof DeferredTimeoutError) {
              span.setAttribute("voice.twilio.dial_outcome", "stream_connect_timeout");
            }
            throw err;
          }
          setSpanAttributes(span, {
            "voice.twilio.stream_connect_latency_ms": Math.round(
              performance.now() - dialWaitStarted,
            ),
          });
        }
      },
    );
  }

  /**
   * Refuse an a-leg destination that was not explicitly allowlisted.
   *
   * Default-deny: no `allowedCallees` means no a-leg call at all. The message
   * names the option to set, because "denied" without "here is how to allow it"
   * just sends the caller reading source.
   *
   * Comparison is an exact `Set` lookup on the normalised number, so a
   * near-miss — a prefix, a suffix, an extra space — is a refusal.
   */
  private _assertCalleeAllowed(to: string): void {
    if (!this.allowedCallees) {
      throw new Error(
        `placeCall: attachStream="a-leg" requires allowedCallees. ` +
          `a-leg dials numbers this Twilio account does not own, so ` +
          `destinations are deny-by-default: pass ` +
          `new TwilioAgentAdapter({ allowedCallees: [...] }) listing every ` +
          `number this adapter may dial, including ${redactE164(to)}.`,
      );
    }
    if (!this.allowedCallees.has(normalizeE164(to))) {
      throw new Error(
        `placeCall: destination ${redactE164(to)} is not in ` +
          `allowedCallees. Add it to ` +
          `new TwilioAgentAdapter({ allowedCallees: [...] }) to permit this ` +
          `destination.`,
      );
    }
  }

  /**
   * Refuse DTMF on a call whose media stream rides our own leg (#762 AC10).
   *
   * `sendDtmf` works by `calls(sid).update({ twiml })`, which REPLACES the
   * TwiML the call is executing. Under b-leg that TwiML is a `<Say>` +
   * `<Pause>` hold on our leg, so replacing it costs nothing — the Media Stream
   * lives on the callee's leg. Under a-leg the TwiML being replaced IS the
   * `<Connect><Stream>` verb carrying the scenario, so the same REST call would
   * redirect the call away from the socket and end the media session mid-run.
   *
   * Armed off `_streamNonce` — set only by an a-leg `placeCall`, the same
   * signal the media loop uses to arm nonce enforcement — rather than
   * re-derived from the caller's arguments here.
   */
  private _assertDtmfSupported(): void {
    if (this._streamNonce !== undefined) {
      throw new Error(A_LEG_SEND_DTMF_UNSUPPORTED);
    }
  }

  /**
   * Refuse to originate until the public URL is reachable from the edge.
   *
   * Delegates to whatever readiness probe was supplied. No probe means the
   * caller owns a stable public URL and there is nothing to wait for.
   */
  private async _assertTunnelReady(): Promise<void> {
    if (!this.tunnelReadiness) return;
    try {
      await this.tunnelReadiness.waitUntilEdgeReachable();
    } catch (err) {
      if (err instanceof TunnelNotReadyError) throw err;
      throw new TunnelNotReadyError(
        `placeCall: publicBaseUrl ${JSON.stringify(this.publicBaseUrl)} is not ` +
          `reachable from the edge yet, so Twilio's media stream would ` +
          `connect to nothing. Not originating.`,
        { cause: err },
      );
    }
  }

  async waitForCall(timeoutMs = 120_000): Promise<void> {
    this._assertConnected();
    const rest = this._rest;
    const publicBaseUrl = this.publicBaseUrl;
    const phoneNumberSid = this._phoneNumberSid;
    if (!rest || publicBaseUrl === undefined || phoneNumberSid === undefined) {
      throw new Error("TwilioAgentAdapter: not connected for answering");
    }
    this._enterMode("answer");

    // NEW `voice.adapter.dial` span (#775 Tier 2a) — see placeCall()'s
    // comment for the rationale (self-instrumented, no executor span active
    // here).
    await voiceSpan(
      "voice.adapter.dial",
      {
        "voice.adapter.class": this.constructor.name,
        "voice.twilio.direction": "inbound",
        "voice.twilio.to": redactE164(this.phoneNumber),
      },
      async (span) => {
        this._priorVoiceUrl =
          (await rest.readVoiceUrl(phoneNumberSid)) ?? undefined;
        const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/twilio/voice`;
        await rest.writeVoiceUrl(phoneNumberSid, webhookUrl);

        const dialWaitStarted = performance.now(); // monotonic
        try {
          await this._streamConnected.promiseWithTimeout(timeoutMs);
        } catch (err) {
          // Nobody dialed in — tag the outcome BEFORE re-throwing ONLY when
          // it's genuinely the timeout (matches Python's
          // `except asyncio.TimeoutError` scoping). The re-thrown error
          // still marks the span ERROR either way (voiceSpan's own
          // exception handling).
          if (err instanceof DeferredTimeoutError) {
            span.setAttribute("voice.twilio.dial_outcome", "stream_connect_timeout");
          }
          throw err;
        }
        setSpanAttributes(span, {
          "voice.twilio.call_sid": this._callSid,
          "voice.twilio.stream_connect_latency_ms": Math.round(
            performance.now() - dialWaitStarted,
          ),
        });
      },
    );
  }

  private _enterMode(mode: TwilioAdapterMode): void {
    if (this._mode === mode) return; // idempotent retry
    if (this._mode !== "idle") {
      throw new Error(
        `TwilioAgentAdapter: already in '${this._mode}' mode; cannot switch to ` +
          `'${mode}'. Disconnect and reconnect to reuse this adapter in the ` +
          `other direction.`,
      );
    }
    this._mode = mode;
  }

  // ------------------------------------------------------- max call duration

  /**
   * Start the wall-clock watchdog that ends `callSid` after `seconds`.
   *
   * Any previously-armed timer is cancelled first, so a second `placeCall` on
   * the same adapter can never leave an older call's timer alive to hang up the
   * newer call's SID.
   */
  private _armMaxDurationTimer(seconds: number, callSid: string, to: string): void {
    this._cancelMaxDurationTimer();
    const generation = this._maxDurationGeneration;
    void (async () => {
      await this._awaitMaxDuration(seconds * 1000);
      if (generation !== this._maxDurationGeneration) return; // cancelled or superseded
      await this._onMaxDurationExpired(seconds, callSid, to);
    })();
  }

  /** Disarm the watchdog. Idempotent; safe when none was ever armed. */
  _cancelMaxDurationTimer(): void {
    this._maxDurationGeneration += 1;
    if (this._maxDurationTimeout !== null) {
      clearTimeout(this._maxDurationTimeout);
      this._maxDurationTimeout = null;
    }
  }

  /**
   * Wait until the duration cap elapses.
   *
   * Test seam (same role as `_driveMediaStream`): tests replace this on the
   * instance to drive expiry on controlled time instead of waiting for real.
   */
  protected async _awaitMaxDuration(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this._maxDurationTimeout = setTimeout(resolve, ms);
    });
  }

  /**
   * Hang up the call and close the socket once the cap elapses.
   *
   * The belt to Twilio's `TimeLimit` suspenders: it fires even if the
   * Twilio-side limit was misconfigured or silently dropped. Cancelled (and
   * therefore silent) on `disconnect()`, at stream end, and on re-arm.
   */
  private async _onMaxDurationExpired(
    seconds: number,
    callSid: string,
    to: string,
  ): Promise<void> {
    twilioLogger.warn("max call duration reached — ending call", {
      seconds,
      to: redactE164(to),
      callSid,
    });
    this._setStreamEndedReason("max_duration");
    const rest = this._rest;
    if (rest) {
      try {
        await rest.endCall(callSid);
      } catch {
        // Best-effort: Twilio's own TimeLimit is the backstop for this backstop.
      }
    }
    try {
      this._streamWs?.close();
    } catch {
      // Socket already gone; nothing left to close.
    }
  }

  // ------------------------------------------------------------------ I/O

  override async sendAudio(chunk: AudioChunk): Promise<void> {
    this._assertStreamLive();
    const streamWs = this._streamWs;
    const streamSid = this._streamSid;
    if (!streamWs || streamSid === undefined) {
      throw new Error("TwilioAgentAdapter: stream not live");
    }
    const mulaw = pcm16_24kToMulaw8k(chunk.data);
    const frameSecs = TWILIO_FRAME_MS / 1000;
    for (const frame of iterMulawFrames(mulaw)) {
      if (frame.length === 0) continue;
      streamWs.send(buildMediaFrame(streamSid, frame));
      // Pace at real-time. Without pacing, the whole utterance arrives in
      // milliseconds, which trips bots' VAD into a clipped-utterance reading.
      await sleep(frameSecs * 1000);
    }
  }

  override async receiveAudio(timeout: number): Promise<AudioChunk> {
    // Once the media-stream loop has ended (stop / socket close / throw),
    // `_handleStreamSocket` nulls `_streamWs`/`_streamSid` synchronously right
    // after the loop returns. The drain loop (`drainAgentResponse`) always makes
    // a *second* receiveAudio call after the first chunk — by then liveness has
    // flipped. So the liveness assert only guards the genuinely-live-and-idle
    // case; buffered audio and the end-of-call drain bypass it (#695).
    //
    // Two sentinel sources cooperate here, and BOTH are load-bearing: the
    // loop's `finally` ENQUEUES one empty chunk — that is what wakes a consumer
    // already blocked in `take()` at the moment the call ends (flipping
    // `_streamEnded` alone wakes nobody) — and this method SYNTHESIZES further
    // empty chunks for every call after the queue has drained (the tail-silence
    // probe, or any caller that keeps polling). Delete either and a hang comes
    // back.
    if (!this._inboundQueue.isEmpty()) {
      // Buffered audio or the loop-enqueued terminal sentinel — drain it,
      // live or not.
      return this._inboundQueue.take(timeout * 1000);
    }
    if (this._streamEnded) {
      // Call ended and fully drained: synthesize another empty sentinel.
      return new AudioChunk({ data: new Uint8Array(0) });
    }
    // Live call, nothing buffered yet: assert liveness, then wait.
    this._assertStreamLive();
    return this._inboundQueue.take(timeout * 1000);
  }

  /**
   * Send DTMF digits on the live call (uses Twilio REST `<Play digits>`).
   *
   * Refused in a-leg mode (#762 AC10) — see {@link _assertDtmfSupported}.
   */
  async sendDtmf(tones: string): Promise<void> {
    this._assertDtmfSupported();
    if (!this._rest || !this._callSid) {
      throw new Error(
        "TwilioAgentAdapter: no active call; sendDtmf requires an in-progress call.",
      );
    }
    await this._rest.sendDtmfOnCall(this._callSid, tones);
  }

  override async interrupt(): Promise<void> {
    this._assertStreamLive();
    const streamWs = this._streamWs;
    const streamSid = this._streamSid;
    if (!streamWs || streamSid === undefined) {
      throw new Error("TwilioAgentAdapter: stream not live");
    }
    streamWs.send(buildClearFrame(streamSid));
  }

  // ------------------------------------------------------------------ server callbacks

  /**
   * Test seam: the running webhook server's bound HTTP base URL (e.g.
   * `http://127.0.0.1:54321`). Useful for tests that don't want a tunnel.
   * Throws if the adapter isn't connected.
   */
  get localBaseUrl(): string {
    if (!this._webhookServer) {
      throw new Error("TwilioAgentAdapter: not connected; localBaseUrl unavailable.");
    }
    return this._webhookServer.baseUrl;
  }

  /**
   * Test seam: directly drive a media-stream loop over a provided socket.
   * Production code reaches the loop via the `/twilio/stream` route.
   */
  async _driveMediaStream(ws: MediaStreamWebSocket): Promise<void> {
    if (!this._webhookServer) {
      throw new Error("TwilioAgentAdapter: not connected; cannot drive stream.");
    }
    await this._webhookServer.mediaStreamLoop(ws);
  }

  /**
   * Test seam: drive the FULL production per-connection wrapper
   * ({@link TwilioWebhookServer.runStreamSession}) over a provided socket — the
   * loop PLUS the `finally` that nulls `_streamWs`/`_streamSid`, exactly as the
   * real `/twilio/stream` handler does after a call ends. Unlike
   * {@link _driveMediaStream} (loop only), this reproduces the #695 teardown
   * race so a follow-up `receiveAudio` runs against nulled transport state.
   */
  async _driveStreamSession(ws: MediaStreamWebSocket): Promise<void> {
    if (!this._webhookServer) {
      throw new Error("TwilioAgentAdapter: not connected; cannot drive stream.");
    }
    await this._webhookServer.runStreamSession(ws);
  }

  /**
   * Called by the server when an inbound webhook is rejected (caller filter
   * or bad signature). Exposed for tests; production callers see the HTTP
   * response and never look at this counter.
   */
  rejectedCount = 0;

  // --- internal accessors used by the server ---------------------------------

  /** @internal */ _setStreamWs(ws: MediaStreamWebSocket | null): void {
    this._streamWs = ws;
  }
  /** @internal */ _setStreamSid(sid: string | undefined): void {
    this._streamSid = sid;
  }
  /** @internal */ _setCallSid(sid: string | undefined): void {
    if (!this._callSid) this._callSid = sid;
  }
  /**
   * @internal A-leg WS auth expectation the media loop enforces (#762): the
   * per-call nonce minted at origination, or `undefined` in every un-gated mode
   * (b-leg, originator-only, inbound). Presence ARMS enforcement.
   */
  get _streamNonceForServer(): string | undefined {
    return this._streamNonce;
  }
  /** @internal The call SID origination returned — what a `start` frame's
   * callSid must match in a-leg mode. */
  get _callSidForServer(): string | undefined {
    return this._callSid;
  }
  /** @internal */ _signalStreamConnected(): void {
    this._streamConnected.resolve();
  }
  /** @internal */ _enqueueInbound(chunk: AudioChunk): void {
    this._inboundQueue.put(chunk);
  }
  /** @internal */ _markStreamEnded(): void {
    this._streamEnded = true;
  }
  /**
   * @internal Re-arm per-CALL state at media-stream-loop entry. Both halves are
   * per-call, not per-connection, so a second session on the same connected
   * adapter must not inherit either of them.
   *
   * The flag alone is not enough: the previous call's `finally` ENQUEUED a
   * terminal sentinel, and if that call ended while no drain was running (the
   * caller hung up between turns) the sentinel is still buffered. `receiveAudio`
   * drains a non-empty queue without checking liveness, so the new call's first
   * `receiveAudio` would hand that stale empty chunk to `drainAgentResponse` as
   * its first chunk — and the drain breaks on an empty chunk, truncating the new
   * call's first agent turn to silence.
   *
   * No frame of this call has been enqueued yet, so buffered chunks are the
   * previous session's residue. `clearBuffered` (not `reset`) so a consumer
   * already parked in `take()` stays parked for the new call's real audio.
   */
  _resetCallState(): void {
    this._streamEnded = false;
    this._inboundQueue.clearBuffered();
  }
  /** @internal Test-only view of the transport state the server nulls on teardown. */
  get _streamWsForTest(): MediaStreamWebSocket | null {
    return this._streamWs;
  }
  /** @internal Test-only view of the transport state the server nulls on teardown. */
  get _streamSidForTest(): string | undefined {
    return this._streamSid;
  }
  /** @internal Test-only view of the disconnect-counter (#775 review): lets a
   * test poll for a REAL wire delivery to have landed before proceeding,
   * instead of a blind sleep. */
  get _framesReceivedForTest(): number {
    return this._framesReceived;
  }
  /** @internal */ _onWebhookRejected(): void {
    this.rejectedCount += 1;
  }
  /** @internal */ get _modeForServer(): TwilioAdapterMode {
    return this._mode;
  }
  /** @internal Disconnect-counter (#775 Tier 2b): one `media` frame received. */
  _recordFrameReceived(): void {
    this._framesReceived += 1;
  }
  /** @internal Disconnect-counter (#775 Tier 2b): one `dtmf` frame received. */
  _recordDtmfReceived(): void {
    this._dtmfReceived += 1;
  }
  /**
   * @internal Disconnect-counter (#775 Tier 2b): how the media session ended.
   *
   * The max-duration watchdog closes the socket itself, so the media loop's own
   * "close" verdict lands moments later and would otherwise mask WHY the call
   * ended — the cap's verdict wins ties. `connect()`/`disconnect()` assign the
   * field directly and so still clear it for the next session.
   */
  _setStreamEndedReason(reason: TwilioStreamEndedReason): void {
    if (this._streamEndedReason === "max_duration") return;
    this._streamEndedReason = reason;
  }
  /** @internal Disconnect-counter (#775 Tier 2b): one `/twilio/voice` POST. */
  _recordWebhookInvocation(): void {
    this._webhookInvocations += 1;
  }

  // ------------------------------------------------------------------ assertions

  private _assertConnected(): void {
    if (!this._connected) {
      throw new Error("TwilioAgentAdapter: not connected; call connect() first.");
    }
  }

  private _assertStreamLive(): void {
    this._assertConnected();
    if (!this._streamWs || !this._streamSid) {
      throw new Error(
        "TwilioAgentAdapter: no live media stream. Call placeCall() or " +
          "waitForCall() first.",
      );
    }
  }
}

// ---------------------------------------------------------------- helpers

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  promiseWithTimeout(timeoutMs: number): Promise<T>;
}

/**
 * Thrown by {@link Deferred.promiseWithTimeout} specifically when the
 * timeout elapses — a distinct type (not a plain `Error`) so callers
 * (placeCall/waitForCall's `dial_outcome` tagging) can precisely distinguish
 * "the wait timed out" from any OTHER rejection of the underlying deferred
 * (e.g. a future `.reject(...)` caller), matching Python's
 * `except asyncio.TimeoutError` scoping (#775 review fix — the original code
 * tagged ANY rejection as a timeout).
 */
class DeferredTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`TwilioAgentAdapter: timed out after ${timeoutMs}ms`);
    this.name = "DeferredTimeoutError";
  }
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
    async promiseWithTimeout(timeoutMs: number): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, rej) => {
            timer = setTimeout(
              () => rej(new DeferredTimeoutError(timeoutMs)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/**
 * Single-producer/single-consumer queue with timeout-aware take. Audio
 * chunks pile up if `receiveAudio` is not actively draining; `take()` is the
 * only consumer the executor uses.
 */
class InboundQueue {
  private _items: AudioChunk[] = [];
  private _waiters: Array<{
    resolve: (chunk: AudioChunk) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  /** True when no buffered chunk is immediately available to `take()`. */
  isEmpty(): boolean {
    return this._items.length === 0;
  }

  /**
   * Drop buffered chunks but leave parked waiters alone — unlike {@link reset},
   * which also rejects them. Used at media-stream-loop entry to clear the
   * previous call's residue without failing a consumer already waiting on the
   * new call's audio.
   */
  clearBuffered(): void {
    this._items = [];
  }

  reset(): void {
    this._items = [];
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("TwilioAgentAdapter: stream reset before audio arrived."));
    }
    this._waiters = [];
  }

  put(chunk: AudioChunk): void {
    const waiter = this._waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(chunk);
      return;
    }
    this._items.push(chunk);
  }

  take(timeoutMs: number): Promise<AudioChunk> {
    const head = this._items.shift();
    if (head) return Promise.resolve(head);
    return new Promise<AudioChunk>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`TwilioAgentAdapter: no audio received within ${timeoutMs}ms`));
      }, timeoutMs);
      this._waiters.push({ resolve, reject, timer });
    });
  }
}
