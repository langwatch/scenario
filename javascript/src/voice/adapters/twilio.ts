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

import { sleep } from "../utils";

import { AgentRole } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";

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
  }

  // ------------------------------------------------------------------ direction

  async placeCall(args: {
    to: string;
    timeoutMs?: number;
    attachStreamToSelf?: boolean;
  }): Promise<void> {
    this._assertConnected();
    this._enterMode("call");
    validateE164(args.to);

    const attachStreamToSelf = args.attachStreamToSelf ?? true;
    const timeoutMs = args.timeoutMs ?? 120_000;

    if (attachStreamToSelf) {
      this._calleePhoneNumberSid = await this._rest!.resolvePhoneNumberSid(args.to);
      this._priorCalleeVoiceUrl =
        (await this._rest!.readVoiceUrl(this._calleePhoneNumberSid)) ?? undefined;
      const webhookUrl = `${this.publicBaseUrl!.replace(/\/$/, "")}/twilio/voice`;
      await this._rest!.writeVoiceUrl(this._calleePhoneNumberSid, webhookUrl);
    }

    const inlineALegTwiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Say voice="Polly.Joanna">${PLACE_CALL_A_LEG_SAY_TEXT}</Say>` +
      `<Pause length="120"/>` +
      `</Response>`;
    this._callSid = await this._rest!.placeCall({
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
    this._enterMode("answer");

    this._priorVoiceUrl =
      (await this._rest!.readVoiceUrl(this._phoneNumberSid!)) ?? undefined;
    const webhookUrl = `${this.publicBaseUrl!.replace(/\/$/, "")}/twilio/voice`;
    await this._rest!.writeVoiceUrl(this._phoneNumberSid!, webhookUrl);
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
    const mulaw = pcm16_24kToMulaw8k(chunk.data);
    const frameSecs = TWILIO_FRAME_MS / 1000;
    for (const frame of iterMulawFrames(mulaw)) {
      if (frame.length === 0) continue;
      this._streamWs!.send(buildMediaFrame(this._streamSid!, frame));
      // Pace at real-time. Without pacing, the whole utterance arrives in
      // milliseconds, which trips bots' VAD into a clipped-utterance reading.
      await sleep(frameSecs * 1000);
    }
  }

  override async receiveAudio(timeout: number): Promise<AudioChunk> {
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
    this._streamWs!.send(buildClearFrame(this._streamSid!));
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
