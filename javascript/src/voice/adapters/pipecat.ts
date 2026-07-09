/**
 * PipecatAgentAdapter — WebSocket client to a user-run Pipecat bot.
 *
 * Pipecat is a framework for BUILDING voice agents. The user runs their
 * Pipecat bot separately (e.g. `python bot.py -t twilio --port 8765`) and
 * this adapter connects as a client to exchange audio with it.
 *
 * Wire protocol. A pipecat bot configured with the `-t twilio` transport
 * uses `TwilioFrameSerializer` on its WebSocket — the same Twilio Media
 * Streams JSON protocol scenario's TwilioAgentAdapter (PR11) will speak.
 * Scenario impersonates Twilio: sends a synthetic `connected` + `start`
 * event with fake stream/call SIDs, then exchanges `media` events
 * carrying base64-encoded µ-law 8kHz audio.
 *
 * `transport="webrtc"` (SmallWebRTC) is not implemented in this PR — it
 * raises {@link PendingTransportError} at `connect()` time and is tracked
 * in a follow-up issue.
 *
 * Python parity: `python/scenario/voice/adapters/pipecat.py`.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { AgentRole } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { sleep } from "../utils";
import { PendingTransportError } from "./pending-transport-error";
import {
  TWILIO_FRAME_MS,
  buildClearFrame,
  buildMarkFrame,
  buildMediaFrame,
  iterMulawFrames,
  mulaw8kToPcm16At24k,
  parseMediaStreamFrame,
  pcm16At24kToMulaw8k,
} from "./twilio-shared";

/** Pipecat transport modes. WebRTC is deferred — see follow-up. */
export type PipecatTransport = "websocket" | "webrtc";

/**
 * Minimal WebSocket surface the adapter needs. Modeled on the `ws`
 * package's API. Exposed so tests can inject a fake without pulling in
 * `ws` or a real WS server.
 */
export interface PipecatWebSocketLike {
  send(data: string | Uint8Array): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "open", listener: () => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  removeAllListeners(event?: string): this;
}

/** Factory that constructs a {@link PipecatWebSocketLike}. */
export type PipecatWebSocketFactory = (url: string) => PipecatWebSocketLike;

export interface PipecatAgentAdapterInit {
  /** WS endpoint of the running Pipecat bot (required for `transport="websocket"`). */
  url?: string;
  /** WebRTC signaling endpoint (required for `transport="webrtc"`). */
  signalingUrl?: string;
  /** Transport mode. Default: `"websocket"`. */
  transport?: PipecatTransport;
  /** Wire audio format the bot expects. Default: `"mulaw"`. */
  audioFormat?: string;
  /** Wire sample rate the bot expects. Default: 8000. */
  sampleRate?: number;
  /** Synthetic stream SID. Auto-generated if omitted. */
  streamSid?: string;
  /** Synthetic call SID. Auto-generated if omitted. */
  callSid?: string;
  /**
   * WebSocket factory — defaults to dynamic-importing the `ws` package
   * at `connect()` time. Tests inject a fake to drive the protocol
   * synchronously without a real server.
   */
  webSocketFactory?: PipecatWebSocketFactory;
  /**
   * Pace outbound µ-law frames at real-time (20ms each) when true.
   * Defaults to true to match production behavior. Tests pass false to
   * avoid waiting through real-time clocks.
   */
  realTimePacing?: boolean;
}

/**
 * Internal: enqueue an incoming AudioChunk or unblock a waiter.
 *
 * The receive loop is producer-side; `receiveAudio(timeout)` is
 * consumer-side. We use a small FIFO + a single-waiter pattern so the
 * common case (consumer arrives after producer) and the racy case
 * (consumer waits before producer) both work without external sync.
 */
interface AudioInbox {
  queue: AudioChunk[];
  waiter: { resolve: (chunk: AudioChunk) => void; reject: (err: Error) => void } | null;
  closed: boolean;
}

/**
 * Twilio Media Streams 20-ms frame interval, in seconds, used for
 * real-time pacing. 20 ms × 1000 = 0.02s.
 */
const FRAME_INTERVAL_SEC = TWILIO_FRAME_MS / 1000;

/**
 * Receive-side coalescing window. Pipecat bots emit one 20-ms µ-law
 * frame at a time; we batch ~100 ms (= 800 µ-law bytes) before resampling
 * to 24 kHz PCM16 so the AudioChunk queue carries chunks at a useful
 * granularity instead of one chunk per frame.
 */
const RECV_BATCH_MULAW_BYTES = 800;

/**
 * Adapter that drives a running Pipecat bot over the Twilio Media
 * Streams WS protocol. Default audio format = µ-law 8 kHz mono, which is
 * what Pipecat's `TwilioFrameSerializer` expects.
 */
export class PipecatAgentAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;

  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    // Pipecat handles VAD on its side; the SDK should NOT layer
    // webrtcvad on top of the inbound audio stream.
    nativeVad: true,
    dtmf: false,
    // Pipecat over the Twilio WS transport speaks Twilio Media Streams;
    // the `clear` event drops all buffered outbound audio on the bot
    // side. That's first-class interrupt — no VAD timing race.
    interruption: true,
    inputFormats: ["pcm16/24000", "mulaw/8000"],
    outputFormats: ["pcm16/24000", "mulaw/8000"],
  });

  readonly url?: string;
  readonly signalingUrl?: string;
  readonly transport: PipecatTransport;
  readonly audioFormat: string;
  readonly sampleRate: number;
  streamSid?: string;
  callSid?: string;

  private readonly webSocketFactory?: PipecatWebSocketFactory;
  private readonly realTimePacing: boolean;
  private ws: PipecatWebSocketLike | null = null;
  private inbox: AudioInbox | null = null;
  /**
   * Serializes concurrent sendAudio() calls. Without this two paced
   * senders would interleave 20-ms µ-law frames on the wire and the bot
   * would receive corrupted audio. Modeled as a promise chain — `await
   * sendLock`, do work, install a new tail.
   */
  private sendLock: Promise<void> = Promise.resolve();
  /**
   * Receive-side coalescing buffer. Inbound µ-law arrives one 20-ms frame
   * at a time; we batch ~100 ms before resampling to 24 kHz PCM16 so the
   * downstream chunk granularity is useful, not per-frame. Stored as an
   * array of Uint8Array slices rather than a `number[]` so each
   * `bufferMulaw` call is O(1) instead of O(n) per byte.
   */
  private mulawChunks: Uint8Array[] = [];
  private mulawChunksByteLength = 0;
  /**
   * Single interruption state flag — collapses what were previously two
   * always-in-sync boolean fields (`interrupted` + `discardingInboundAudio`).
   *
   * `"idle"` (default): normal operation; both gates open.
   * `"interrupted"`: set by {@link interrupt}; both gates closed until
   *   the recovery turn's `sendAudio` resets to `"idle"`.
   *
   * The two consumer points that previously read the separate flags now both
   * check this field:
   * - `receiveAudio`: returns empty sentinel when `"interrupted"` (stops
   *   drainAgentResponse after the waiter wake).
   * - `bufferMulaw`: drops inbound WS frames when `"interrupted"` (prevents
   *   late-arriving bot frames from polluting the next turn's inbox).
   *
   * The flags were always set and cleared together; unifying them removes the
   * subtle risk of one advancing while the other lags.
   */
  private interruptPhase: "idle" | "interrupted" = "idle";

  constructor(init: PipecatAgentAdapterInit = {}) {
    super();
    const transport = init.transport ?? "websocket";
    if (transport === "websocket" && !init.url) {
      throw new Error(
        "PipecatAgentAdapter(transport='websocket') requires url=",
      );
    }
    if (transport === "webrtc" && !init.signalingUrl) {
      throw new Error(
        "PipecatAgentAdapter(transport='webrtc') requires signalingUrl=",
      );
    }
    this.url = init.url;
    this.signalingUrl = init.signalingUrl;
    this.transport = transport;
    this.audioFormat = init.audioFormat ?? "mulaw";
    this.sampleRate = init.sampleRate ?? 8000;
    this.streamSid = init.streamSid;
    this.callSid = init.callSid;
    this.webSocketFactory = init.webSocketFactory;
    this.realTimePacing = init.realTimePacing ?? true;
  }

  /** Convenience: `"<audioFormat>/<sampleRate>"`. Used in tests + matrix docs. */
  get transportFormat(): string {
    return `${this.audioFormat}/${this.sampleRate}`;
  }

  // call() is inherited from VoiceAgentAdapter (defaultVoiceCall) — the executor
  // drives the send → drain → record loop through sendAudio/receiveAudio
  // (Gap #11). No leaf-level override.

  // ---------------------------------------------------------------- lifecycle

  override async connect(): Promise<void> {
    if (this.transport === "webrtc") {
      throw new PendingTransportError("PipecatAgentAdapter(transport='webrtc')");
    }

    if (!this.url) {
      // Defensive — constructor already validated this. Keeps the type
      // narrowing happy below.
      throw new Error("PipecatAgentAdapter: url is required for WebSocket transport");
    }

    const factory = this.webSocketFactory ?? (await defaultWebSocketFactory());
    const ws = factory(this.url);
    this.ws = ws;
    this.inbox = { queue: [], waiter: null, closed: false };
    this.mulawChunks = [];
    this.mulawChunksByteLength = 0;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeAllListeners("error");
        // Attach steady-state listeners atomically. Without this, an
        // `error` between `open` and the next `on('error')` call would
        // crash the Node process (unhandled EventEmitter error).
        ws.on("message", (data) => this.onMessage(data));
        ws.on("error", (err) => this.onSocketError(err));
        ws.on("close", () => this.onSocketClose());
        resolve();
      };
      ws.once("open", onOpen);
      ws.once("error", (err) => {
        ws.removeAllListeners("open");
        reject(err);
      });
    });

    if (!this.streamSid) this.streamSid = `MZ${randomUUID().replace(/-/g, "")}`;
    if (!this.callSid) this.callSid = `CA${randomUUID().replace(/-/g, "")}`;

    // Synthetic `connected` + `start` handshake mirroring what Twilio
    // sends on a real call. Pipecat's TwilioFrameSerializer requires
    // these before it'll deserialize media frames.
    ws.send(
      JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }),
    );
    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: this.streamSid,
        start: {
          streamSid: this.streamSid,
          callSid: this.callSid,
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
        },
      }),
    );
  }

  /** Whether the Media Streams WebSocket is open (Gap #11). */
  override isConnected(): boolean {
    return this.ws !== null;
  }

  override async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;

    // Best-effort `stop` so the bot can clean up its pipeline. Failures
    // here are not interesting — the socket may already be torn down.
    try {
      if (this.streamSid) {
        ws.send(JSON.stringify({ event: "stop", streamSid: this.streamSid }));
      }
    } catch {
      // Swallow — disconnect() is best-effort.
    }

    if (this.inbox) {
      this.inbox.closed = true;
      this.inbox.waiter?.reject(
        new Error("PipecatAgentAdapter: disconnected while waiting for audio"),
      );
      this.inbox = null;
    }

    try {
      ws.close();
    } catch {
      // Socket may already be closed by the peer.
    }

    this.ws = null;
    this.streamSid = undefined;
    this.callSid = undefined;
  }

  // ---------------------------------------------------------------- I/O

  override async sendAudio(chunk: AudioChunk): Promise<void> {
    this.assertConnected();
    // Clear stale interrupt state from the previous turn. `interrupt()` is
    // always followed by the recovery turn's `sendAudio`, making this the
    // correct reset point for the per-turn signal.
    this.interruptPhase = "idle";
    const ws = this.ws;
    const streamSid = this.streamSid;
    if (!ws || streamSid === undefined) {
      throw new Error("PipecatAgentAdapter: not connected");
    }
    const mulaw = pcm16At24kToMulaw8k(chunk.data);

    const previous = this.sendLock;
    let release!: () => void;
    this.sendLock = new Promise((r) => {
      release = r;
    });
    await previous;
    try {
      for (const frame of iterMulawFrames(mulaw)) {
        // Drop short trailing frames; Pipecat's deserializer expects
        // 160-byte frames and short ones produce decode glitches.
        if (frame.length === 0) continue;
        ws.send(buildMediaFrame(streamSid, frame));
        if (this.realTimePacing) await sleep(FRAME_INTERVAL_SEC * 1000);
      }
      ws.send(buildMarkFrame(streamSid, "utterance_end"));
    } finally {
      release();
    }
  }

  override async receiveAudio(timeout: number): Promise<AudioChunk> {
    this.assertConnected();
    // Interrupt gate: `interrupt()` set this phase after clearing `inbox.queue`.
    // Return an empty sentinel so `drainAgentResponse`'s while loop breaks and
    // records only the audio received before the barge-in. Consume the phase so
    // subsequent calls (e.g. on the recovery turn) behave normally.
    if (this.interruptPhase === "interrupted") {
      this.interruptPhase = "idle";
      return new AudioChunk({ data: new Uint8Array(0) });
    }
    const inbox = this.inbox;
    if (!inbox) {
      throw new Error("PipecatAgentAdapter: not connected");
    }
    const queued = inbox.queue.shift();
    if (queued) return queued;
    if (inbox.closed) {
      throw new Error("PipecatAgentAdapter: socket closed, no audio available");
    }
    return await new Promise<AudioChunk>((resolve, reject) => {
      const timer = setTimeout(() => {
        inbox.waiter = null;
        reject(new Error(`PipecatAgentAdapter: receiveAudio timed out after ${timeout}s`));
      }, timeout * 1000);
      inbox.waiter = {
        resolve: (chunk) => {
          clearTimeout(timer);
          resolve(chunk);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  /**
   * Send a Twilio `clear` frame and truncate the JS-side receive buffer.
   *
   * Side effects:
   * 1. `inbox.queue` cleared — discards buffered PCM chunks not yet consumed
   *    by `drainAgentResponse`.
   * 2. `mulawChunks` cleared — discards partially-accumulated µ-law that
   *    hasn't been resampled yet.
   * 3. Active `receiveAudio` waiter (if any) woken with an empty chunk so
   *    `drainAgentResponse` breaks its loop immediately without a timeout.
   * 4. `interruptPhase` set to `"interrupted"` — the NEXT `receiveAudio` call
   *    returns an empty sentinel (stops the drain loop after the waiter wake),
   *    and `bufferMulaw` discards late-arriving WS frames until the recovery
   *    turn's `sendAudio` resets the phase to `"idle"`.
   */
  override async interrupt(): Promise<void> {
    this.assertConnected();
    const ws = this.ws;
    const streamSid = this.streamSid;
    if (!ws || streamSid === undefined) {
      throw new Error("PipecatAgentAdapter: not connected");
    }
    ws.send(buildClearFrame(streamSid));
    // JS-side truncation: discard buffered audio so drainAgentResponse stops.
    if (this.inbox) {
      this.inbox.queue = [];
      const w = this.inbox.waiter;
      if (w) {
        this.inbox.waiter = null;
        w.resolve(new AudioChunk({ data: new Uint8Array(0) }));
      }
    }
    // Discard partially-accumulated µ-law that hasn't been flushed to the queue yet.
    this.mulawChunks = [];
    this.mulawChunksByteLength = 0;
    // Gates both receiveAudio (empty sentinel) and bufferMulaw (frame discard)
    // until the recovery turn's sendAudio resets to "idle".
    this.interruptPhase = "interrupted";
  }

  // ---------------------------------------------------------------- internals

  /**
   * Handle one inbound WS frame. Accepts both the string JSON frames
   * Pipecat normally emits and raw binary µ-law payloads (some bot
   * configurations emit binary audio outside the JSON wrapper).
   */
  private onMessage(data: unknown): void {
    if (!this.inbox) return;
    const text = coerceFrameToText(data);
    if (text === null) {
      // Treat unrecognised binary as raw µ-law payload.
      const bytes = coerceFrameToBytes(data);
      if (bytes && bytes.length > 0) this.bufferMulaw(bytes);
      return;
    }
    const frame = parseMediaStreamFrame(text);
    if (!frame) return;
    if (frame.event === "media" && frame.payloadMulaw) {
      this.bufferMulaw(frame.payloadMulaw);
    } else if (frame.event === "stop") {
      this.flushBufferedMulaw();
    }
  }

  private bufferMulaw(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // Drop frames from a just-interrupted bot turn so they don't pollute the
    // next turn's drain. Reset by sendAudio() at the start of each new user turn.
    if (this.interruptPhase === "interrupted") return;
    this.mulawChunks.push(bytes);
    this.mulawChunksByteLength += bytes.length;
    if (this.mulawChunksByteLength >= RECV_BATCH_MULAW_BYTES) this.flushBufferedMulaw();
  }

  private flushBufferedMulaw(): void {
    if (this.mulawChunksByteLength === 0 || !this.inbox) return;
    const mulaw = new Uint8Array(this.mulawChunksByteLength);
    let offset = 0;
    for (const part of this.mulawChunks) {
      mulaw.set(part, offset);
      offset += part.length;
    }
    this.mulawChunks = [];
    this.mulawChunksByteLength = 0;
    const pcm = mulaw8kToPcm16At24k(mulaw);
    const chunk = new AudioChunk({ data: pcm });
    const waiter = this.inbox.waiter;
    if (waiter) {
      this.inbox.waiter = null;
      waiter.resolve(chunk);
    } else {
      this.inbox.queue.push(chunk);
    }
  }

  private onSocketError(_err: Error): void {
    if (!this.inbox) return;
    this.inbox.closed = true;
    const waiter = this.inbox.waiter;
    if (waiter) {
      this.inbox.waiter = null;
      waiter.reject(new Error("PipecatAgentAdapter: socket error"));
    }
  }

  private onSocketClose(): void {
    if (!this.inbox) return;
    this.flushBufferedMulaw();
    this.inbox.closed = true;
    const waiter = this.inbox.waiter;
    if (waiter) {
      this.inbox.waiter = null;
      waiter.reject(new Error("PipecatAgentAdapter: socket closed"));
    }
  }

  private assertConnected(): void {
    if (!this.ws || !this.inbox || !this.streamSid) {
      throw new Error(
        "PipecatAgentAdapter: not connected. Did you forget to call connect()?",
      );
    }
  }
}

/**
 * Resolve incoming WS frame data to a UTF-8 string, or null if it's binary.
 *
 * The `ws` library hands the `message` handler a `Buffer` for both binary
 * and text frames; the distinction is in the `isBinary` second argument
 * the adapter would have to surface separately. We don't (the WebSocketLike
 * surface keeps the handler single-arg for test-injection simplicity), so
 * we fall back to peeking the first byte: JSON-shaped frames must start
 * with `{` (0x7b) or `[` (0x5b). Binary µ-law frames whose first byte
 * happens to equal 0x7b/0x5b will be mis-routed to the JSON parser and
 * silently dropped (parser returns null for non-JSON). That's a known
 * rare-but-possible collision — accepted because real Pipecat bots emit
 * audio only as JSON `media` frames, never as standalone binary.
 */
function coerceFrameToText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) {
    const head = data.length > 0 ? data[0] : 0;
    if (head === 0x7b || head === 0x5b) return data.toString("utf8");
    return null;
  }
  if (data instanceof Uint8Array) {
    const head = data.length > 0 ? data[0] : 0;
    if (head === 0x7b || head === 0x5b) return Buffer.from(data).toString("utf8");
    return null;
  }
  return null;
}

/** Resolve incoming WS frame data to raw bytes, or null if it's a string. */
function coerceFrameToBytes(data: unknown): Uint8Array | null {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null;
}

/**
 * Lazy-import the `ws` package as the default WebSocket factory. Lets
 * tests inject a fake without paying the `ws` import cost in the
 * unit-test path.
 */
async function defaultWebSocketFactory(): Promise<PipecatWebSocketFactory> {
  // Indirected through a dynamic import so the `ws` dep stays out of
  // the synchronous import graph of `scenario.voice`.
  const mod = (await import("ws")) as unknown as {
    default?: new (url: string) => PipecatWebSocketLike;
    WebSocket?: new (url: string) => PipecatWebSocketLike;
  };
  const Ctor = mod.default ?? mod.WebSocket;
  if (!Ctor) {
    throw new Error("PipecatAgentAdapter: could not resolve `ws` WebSocket constructor");
  }
  return (url: string) => new Ctor(url);
}
