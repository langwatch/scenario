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
import { sleep } from "../utils";

import { TwilioWebhookServer, type MediaStreamWebSocket } from "./twilio-server";
import {
  TWILIO_FRAME_MS,
  TwilioRESTHelper,
  buildClearFrame,
  buildMediaFrame,
  iterMulawFrames,
  pcm16_24kToMulaw8k,
  validateE164,
} from "./twilio-shared";

export type TwilioAdapterMode = "idle" | "answer" | "call";

const PLACE_CALL_A_LEG_SAY_TEXT =
  "Thank you for calling. " +
  "I will hold the line while you complete your scenario.";

export interface TwilioAgentAdapterOptions {
  accountSid: string;
  authToken: string;
  /** Twilio-owned phone number in E.164 format (e.g. "+14155551234"). */
  phoneNumber: string;
  /** HTTPS URL routing to this machine. Required at `connect()` time. */
  publicBaseUrl?: string;
  /** Allowed-callers filter for inbound calls. Unset = any caller accepted. */
  allowedCallers?: readonly string[];
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
    this._mode = "idle";
    this._streamConnected = makeDeferred<void>();
    this._inboundQueue.reset();
    this._streamEnded = false;

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

    // Restore prior voice_url (answer mode only).
    if (this._mode === "answer" && this._phoneNumberSid && this._rest) {
      try {
        await this._rest.writeVoiceUrl(this._phoneNumberSid, this._priorVoiceUrl ?? "");
      } catch {
        // Best-effort.
      }
    }
    if (this._mode === "call" && this._calleePhoneNumberSid && this._rest) {
      try {
        await this._rest.writeVoiceUrl(
          this._calleePhoneNumberSid,
          this._priorCalleeVoiceUrl ?? "",
        );
      } catch {
        // Best-effort.
      }
    }

    if (this._webhookServer) {
      await this._webhookServer.stop();
    }
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
    this._streamConnected = makeDeferred<void>();
    this._inboundQueue.reset();
    this._streamEnded = false;
  }

  // ------------------------------------------------------------------ direction

  async placeCall(args: {
    to: string;
    timeoutMs?: number;
    attachStreamToSelf?: boolean;
  }): Promise<void> {
    this._assertConnected();
    const rest = this._rest;
    const publicBaseUrl = this.publicBaseUrl;
    if (!rest || publicBaseUrl === undefined) {
      throw new Error("TwilioAgentAdapter: not connected");
    }
    this._enterMode("call");
    validateE164(args.to);

    const attachStreamToSelf = args.attachStreamToSelf ?? true;
    const timeoutMs = args.timeoutMs ?? 120_000;

    if (attachStreamToSelf) {
      this._calleePhoneNumberSid = await rest.resolvePhoneNumberSid(args.to);
      this._priorCalleeVoiceUrl =
        (await rest.readVoiceUrl(this._calleePhoneNumberSid)) ?? undefined;
      const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/twilio/voice`;
      await rest.writeVoiceUrl(this._calleePhoneNumberSid, webhookUrl);
    }

    const inlineALegTwiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Say voice="Polly.Joanna">${PLACE_CALL_A_LEG_SAY_TEXT}</Say>` +
      `<Pause length="120"/>` +
      `</Response>`;
    this._callSid = await rest.placeCall({
      to: args.to,
      from: this.phoneNumber,
      twiml: inlineALegTwiml,
    });

    if (attachStreamToSelf) {
      await this._streamConnected.promiseWithTimeout(timeoutMs);
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

    this._priorVoiceUrl =
      (await rest.readVoiceUrl(phoneNumberSid)) ?? undefined;
    const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/twilio/voice`;
    await rest.writeVoiceUrl(phoneNumberSid, webhookUrl);
    await this._streamConnected.promiseWithTimeout(timeoutMs);
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

  async sendDtmf(tones: string): Promise<void> {
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
  /** @internal */ _onWebhookRejected(): void {
    this.rejectedCount += 1;
  }
  /** @internal */ get _modeForServer(): TwilioAdapterMode {
    return this._mode;
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
              () => rej(new Error(`TwilioAgentAdapter: timed out after ${timeoutMs}ms`)),
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
