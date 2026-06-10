/**
 * GeminiLiveAgentAdapter — TypeScript port of
 * `python/scenario/voice/adapters/gemini_live.py`.
 *
 * Connects directly to the Gemini Live API via the official `@google/genai`
 * SDK. STT, LLM, and TTS all run on Google's infrastructure; audio flows
 * bidirectionally as raw PCM16.
 *
 * Sample rates:
 *   Canonical internal:  PCM16 mono 24000 Hz  (AudioChunk)
 *   Gemini Live input:   PCM16 mono 16000 Hz  ("audio/pcm;rate=16000")
 *   Gemini Live output:  PCM16 mono 24000 Hz  (docs say 24kHz output)
 *
 * Resampling is linear interpolation in pure JS — no numpy/scipy dependency.
 *
 * Session lifecycle (Decision (b), see PR body):
 *   Unlike Python's `async with client.aio.live.connect(...)` context
 *   manager, the JS SDK exposes `client.live.connect()` as a plain
 *   `Promise<Session>` with `session.close()` to terminate. There is no
 *   need for a background promise pump holding the context open — the
 *   `Session` object itself owns the underlying WebSocket and stays open
 *   between `connect()` and `close()`. We therefore map `connect()` /
 *   `disconnect()` from the {@link VoiceAgentAdapter} base directly onto
 *   the SDK's open/close primitives, with no extra ceremony.
 *
 *   Message dispatch is a separate concern: the JS SDK delivers
 *   {@link LiveServerMessage} via the `onmessage` callback passed to
 *   `connect()`, not via an async iterator. We bridge the callback to an
 *   in-memory queue with a promise-based signal so `receiveAudio(timeout)`
 *   can `await` for the next message with `Promise.race` against a timer.
 */

import { Buffer } from "node:buffer";

import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { GEMINI_LIVE_MODEL } from "../voice-models";

/** Gemini Live ingests PCM16 at 16kHz. */
const GEMINI_INPUT_RATE = 16000;
/** Canonical internal rate. Gemini Live's output rate also equals this. */
const CANONICAL_RATE = 24000;

/**
 * Resample mono PCM16 little-endian bytes between two sample rates using
 * linear interpolation. Returns an even-length byte buffer (PCM16 invariant).
 */
function resamplePcm16(data: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate || data.length === 0) {
    return data;
  }

  const sampleCount = Math.floor(data.length / 2);
  // Read input as little-endian int16.
  const src = new Int16Array(sampleCount);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    src[i] = view.getInt16(i * 2, true);
  }

  const nOut = Math.floor((sampleCount * toRate) / fromRate);
  if (nOut === 0) {
    return new Uint8Array(0);
  }

  const dst = new Int16Array(nOut);
  if (sampleCount === 1) {
    dst.fill(src[0]);
  } else {
    const step = (sampleCount - 1) / (nOut - 1 || 1);
    for (let i = 0; i < nOut; i++) {
      const pos = i * step;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[idx];
      const b = src[Math.min(idx + 1, sampleCount - 1)];
      dst[i] = Math.round(a + (b - a) * frac);
    }
  }

  // Encode back to little-endian bytes.
  let outLen = dst.length * 2;
  if (outLen % 2 === 1) outLen -= 1;
  const out = new Uint8Array(outLen);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < dst.length; i++) {
    outView.setInt16(i * 2, dst[i], true);
  }
  return out;
}

/**
 * Internal message queue entry: each `onmessage` event from the SDK becomes
 * a `Pending` item; a closure event becomes a sentinel `closed: true`.
 * The special `interrupted: true` field is used by the abort-sentinel pattern:
 * `interrupt()` wakes any in-flight `dequeue()` by pushing this sentinel
 * directly into the resolver slot, without competing on the queue.
 */
interface QueueItem {
  message?: unknown;
  closed?: boolean;
  error?: unknown;
  /** Abort sentinel: set by interrupt() to wake a blocked dequeue(). */
  interrupted?: boolean;
}

/**
 * Construction options for {@link GeminiLiveAgentAdapter}.
 */
export interface GeminiLiveAgentAdapterInit {
  /** Live model identifier. Defaults to {@link GEMINI_LIVE_MODEL}. */
  model?: string;
  /** Prebuilt voice name. Defaults to "Algieba". */
  voice?: string;
  /** Optional system instruction sent at session setup. */
  systemInstruction?: string;
  /** Explicit API key. Falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY` env vars. */
  apiKey?: string;
}

/**
 * Gemini Live native-audio adapter.
 *
 * Connects directly to the Gemini Live API via the `@google/genai` SDK.
 * Audio flows bidirectionally as raw PCM16; canonical 24kHz internally,
 * resampled to/from 16kHz at the wire boundary.
 *
 * @remarks
 * The `@google/genai` package is declared as an **optional peer
 * dependency** so the SDK ships without a hard Gemini coupling. Users who
 * import this adapter must install `@google/genai` themselves.
 */
export class GeminiLiveAgentAdapter extends VoiceAgentAdapter {
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: true,
    dtmf: false,
    // With explicit Activity markers and the default
    // START_OF_ACTIVITY_INTERRUPTS handling, the next activityStart we
    // send while the model is replying causes Gemini to cut its
    // in-flight audio. `interrupt()` itself just drains stale chunks out
    // of the local queue so the recovery agent turn doesn't replay them.
    interruption: true,
    inputFormats: ["pcm16/16000"],
    outputFormats: ["pcm16/24000"],
  });

  readonly model: string;
  readonly voice: string;
  readonly systemInstruction: string;

  private readonly apiKey: string;

  // Session state — populated by `connect()`, cleared by `disconnect()`.
  private session: unknown = null;
  private queue: QueueItem[] = [];
  private resolveNext: ((item: QueueItem) => void) | null = null;
  private connected = false;
  /** Tracks whether the current turn iterator has yielded any audio. */
  private iterHadAudio = false;
  /**
   * Abort-sentinel flag. Set by `interrupt()` to signal that any in-flight
   * `receiveAudio()` should return the cut-off sentinel immediately. Cleared
   * by `receiveAudio()` when it observes the flag.
   *
   * This replaces the prior pattern of `interrupt()` calling `dequeue()`
   * concurrently with `receiveAudio()`: that caused the single `resolveNext`
   * slot to be overwritten by the second caller, orphaning the first caller's
   * resolver and causing a spurious TimeoutError.
   */
  private _interruptPending = false;

  /** Most-recent output transcript received from the server, for observability. */
  lastAgentTranscript: string | null = null;

  constructor(init: GeminiLiveAgentAdapterInit = {}) {
    super();
    this.model = init.model ?? GEMINI_LIVE_MODEL;
    this.voice = init.voice ?? "Algieba";
    this.systemInstruction = init.systemInstruction ?? "";
    this.apiKey =
      init.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  }

  // call() is inherited from VoiceAgentAdapter (defaultVoiceCall) — the executor
  // drives the native-audio loop (Gap #11). No leaf-level override.

  // ----------------------------------------------------------------- lifecycle

  /**
   * Open a Gemini Live session.
   *
   * Lazy-imports `@google/genai` so the SDK only loads when this adapter
   * is actually used. Registers an `onmessage` callback that pushes
   * {@link LiveServerMessage} instances onto an internal queue, which
   * {@link receiveAudio} drains.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    let genai: typeof import("@google/genai");
    try {
      genai = await import("@google/genai");
    } catch {
      throw new Error(
        "GeminiLiveAgentAdapter: '@google/genai' is not installed. " +
          "Install it as a peer dependency: `pnpm add @google/genai`.",
      );
    }

    const { GoogleGenAI, Modality } = genai;
    const client = new GoogleGenAI({ apiKey: this.apiKey });

    const config: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: this.voice },
        },
      },
      // Disable Automatic Activity Detection — we drive turn boundaries
      // explicitly via activityStart / activityEnd in sendAudio() so the
      // model replies the moment we close the turn. Mirrors the Python
      // adapter's choice; see python/scenario/voice/adapters/gemini_live.py
      // for the full rationale.
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (this.systemInstruction) {
      config.systemInstruction = this.systemInstruction;
    }

    this.queue = [];
    this.resolveNext = null;
    this.iterHadAudio = false;
    this._interruptPending = false;

    this.session = await client.live.connect({
      model: this.model,
      config: config as never,
      callbacks: {
        onmessage: (msg) => this.enqueue({ message: msg }),
        onerror: (e: unknown) =>
          this.enqueue({ error: e instanceof Error ? e : new Error(String(e)) }),
        onclose: () => this.enqueue({ closed: true }),
      },
    });
    this.connected = true;
  }

  /** Whether the Gemini Live session is open (Gap #11). */
  override isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the Gemini Live session and release the WebSocket.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      const sess = this.session as { close?: () => void | Promise<void> } | null;
      if (sess?.close) {
        await sess.close();
      }
    } catch {
      // Best-effort: closing an already-closed session is fine. Other
      // errors during teardown are non-actionable — we're discarding the
      // session anyway.
    }
    this.session = null;
    this.connected = false;
    this.queue = [];
    if (this.resolveNext) {
      this.resolveNext({ closed: true });
      this.resolveNext = null;
    }
  }

  // ----------------------------------------------------------------------- I/O

  /**
   * Send a canonical 24kHz {@link AudioChunk} to Gemini Live as a complete turn.
   *
   * Resamples 24kHz → 16kHz at the wire boundary and wraps the audio in
   * explicit `activityStart` / `activityEnd` markers. With Automatic Activity
   * Detection disabled (see {@link connect}), each `sendAudio` call is a
   * complete user turn from Gemini's perspective: the model replies the moment
   * we close the turn.
   */
  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.requireConnected();
    const pcm16k = resamplePcm16(chunk.data, CANONICAL_RATE, GEMINI_INPUT_RATE);
    if (pcm16k.length === 0) return;

    // New user turn — reset the per-turn transcript so the agent's first
    // reply text doesn't get permanently prefixed onto every subsequent turn.
    this.lastAgentTranscript = null;
    this.iterHadAudio = false;

    const session = this.session as {
      sendRealtimeInput: (params: Record<string, unknown>) => void;
    };
    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(pcm16k).toString("base64"),
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
      },
    });
    session.sendRealtimeInput({ activityEnd: {} });
  }

  /**
   * Receive the next audio fragment from Gemini Live for the current turn.
   *
   * The SDK delivers messages via an `onmessage` callback that we've bridged
   * to an internal queue. This method walks the queue, accumulating
   * transcript text and audio bytes, and returns:
   *
   *   - the next non-empty audio chunk as soon as it arrives, OR
   *   - an empty {@link AudioChunk} when the turn completes (so the drain
   *     loop's tail-silence path can exit), OR
   *   - re-enters the receive loop transparently on the spurious
   *     "interrupted → turnComplete" pair that the server sometimes emits
   *     between turns (when activityStart for turn N+1 lands during turn
   *     N's playback delay — see Python adapter for the full pattern).
   *
   * Throws {@link Error} with name `"TimeoutError"` if no chunk arrives
   * within `timeout` seconds.
   */
  /**
   * Extra budget granted after detecting the spurious
   * "interrupted → turnComplete" pair (Python's iterator-restart semantic).
   * Gemini typically takes ~3.5 s to produce the recovery reply; 10 s gives
   * comfortable headroom without risking an indefinite hang.
   */
  private static readonly SPURIOUS_PAIR_RECOVERY_MS = 10_000;

  async receiveAudio(timeout: number): Promise<AudioChunk> {
    this.requireConnected();
    let deadline = Date.now() + timeout * 1000;
    let pendingTranscript = "";
    let sawInterrupted = false;

    while (true) {
      // Abort-sentinel check: if interrupt() signalled while we were waiting
      // for the next queue item (or even before we reached dequeue()), return
      // the cut-off sentinel immediately rather than reading stale agent audio.
      // This prevents the single-resolveNext-slot race: interrupt() no longer
      // competes on dequeue() — it just sets this flag and wakes any in-flight
      // dequeue() call via the resolver directly.
      if (this._interruptPending) {
        this._interruptPending = false;
        return new AudioChunk({
          data: new Uint8Array(0),
          transcript: pendingTranscript || undefined,
        });
      }

      const remainingMs = Math.max(0, deadline - Date.now());
      const item = await this.dequeue(remainingMs);

      // Re-check after await — interrupt() may have arrived while dequeue()
      // was suspended. If the sentinel woke dequeue(), item.interrupted is set.
      if (item.interrupted || this._interruptPending) {
        this._interruptPending = false;
        return new AudioChunk({
          data: new Uint8Array(0),
          transcript: pendingTranscript || undefined,
        });
      }

      if (item.error) throw item.error;
      if (item.closed) {
        // Connection closed mid-turn — surface as empty end-of-turn so
        // callers see a graceful shutdown rather than a hang.
        return new AudioChunk({
          data: new Uint8Array(0),
          transcript: pendingTranscript || undefined,
        });
      }

      const msg = item.message as {
        serverContent?: {
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
          turnComplete?: boolean;
          interrupted?: boolean;
          outputTranscription?: { text?: string };
        };
        goAway?: unknown;
      };

      if (msg.goAway) {
        throw new Error(
          `GeminiLiveAgentAdapter: server sent goAway: ${JSON.stringify(msg.goAway).slice(0, 300)}`,
        );
      }

      const sc = msg.serverContent;
      if (!sc) continue;

      if (sc.interrupted) sawInterrupted = true;

      if (sc.outputTranscription?.text) {
        const text = sc.outputTranscription.text;
        pendingTranscript += text;
        this.lastAgentTranscript = (this.lastAgentTranscript ?? "") + text;
      }

      const parts = sc.modelTurn?.parts ?? [];
      if (parts.length > 0) {
        const buffers: Buffer[] = [];
        for (const part of parts) {
          const b64 = part.inlineData?.data;
          if (b64) buffers.push(Buffer.from(b64, "base64"));
        }
        if (buffers.length > 0) {
          let audioBytes = Buffer.concat(buffers);
          if (audioBytes.length % 2 === 1) {
            audioBytes = audioBytes.subarray(0, audioBytes.length - 1);
          }
          if (audioBytes.length > 0) {
            this.iterHadAudio = true;
            return new AudioChunk({
              data: new Uint8Array(
                audioBytes.buffer,
                audioBytes.byteOffset,
                audioBytes.byteLength,
              ),
              transcript: pendingTranscript || undefined,
            });
          }
        }
      }

      if (sc.turnComplete) {
        // Spurious empty-interrupt turn? When activityStart opens turn
        // N+1 after turn N's generationComplete, the server emits
        // "interrupted → turnComplete" with no audio FIRST, then the
        // real reply in a separate turn. Detect that pattern (saw
        // interrupted=true, no audio on THIS iterator, no transcript)
        // and re-enter the receive loop to read the actual reply.
        //
        // Iterator-restart semantic (mirrors Python's session.receive()
        // re-creation): reset per-turn detection state and extend the
        // deadline by SPURIOUS_PAIR_RECOVERY_MS so the loop has ample
        // budget to wait for Gemini's real recovery reply (~3.5 s typical).
        // Without the deadline extension the original timeout may have
        // nearly elapsed by the time the spurious pair fires (e.g. in the
        // live executor the boundary can arrive several seconds after
        // interrupt() completes), causing a TimeoutError before the
        // recovery audio arrives.
        //
        // Unit-tested in src/voice/adapters/__tests__/gemini-live.test.ts:
        // three existing tests + the "delayed recovery" test confirm this
        // path works both synchronously (pre-loaded queue) and with a
        // deliberate async delay between the spurious pair and the real
        // audio.
        if (sawInterrupted && !this.iterHadAudio && !pendingTranscript) {
          // Reset iterator-scope state — as if session.receive() was
          // re-created (Python's pattern).
          sawInterrupted = false;
          // Grant a fresh recovery budget; take the later of the current
          // deadline and now+RECOVERY to avoid shortening a generous
          // original timeout.
          deadline = Math.max(
            deadline,
            Date.now() + GeminiLiveAgentAdapter.SPURIOUS_PAIR_RECOVERY_MS,
          );
          continue;
        }
        // Real end-of-turn — yield empty AudioChunk.
        return new AudioChunk({
          data: new Uint8Array(0),
          transcript: pendingTranscript || undefined,
        });
      }
    }
  }

  /**
   * Signal an in-flight `receiveAudio()` to return the cut-off sentinel
   * immediately, so the interrupted turn doesn't replay stale agent audio
   * into the next turn's drain loop.
   *
   * **Abort-sentinel pattern** (fixes the single-consumer concurrency race):
   *
   * The original implementation called `dequeue()` concurrently with an
   * in-flight `receiveAudio()`. Since `dequeue()` has a single `resolveNext`
   * slot, the second caller (interrupt) overwrote the first caller's
   * (receiveAudio's) resolver. When a message arrived it resolved the
   * interrupt's dequeue, leaving receiveAudio's resolver orphaned — its
   * timer eventually fired with a `TimeoutError`, causing `drainAgentResponse`
   * to catch and break prematurely.
   *
   * Fix: `interrupt()` no longer calls `dequeue()`. Instead it:
   *   1. Sets `_interruptPending = true`.
   *   2. Wakes any in-flight `dequeue()` by calling the current `resolveNext`
   *      directly with an abort sentinel (`{ interrupted: true }`).
   *   3. `receiveAudio()`'s loop checks `_interruptPending` (and `item.interrupted`)
   *      and returns the cut-off sentinel immediately on seeing it.
   *
   * Best-effort: if nothing is in-flight (`resolveNext` is null), the flag
   * stays set and `receiveAudio()` catches it at the top of its next iteration.
   */
  override async interrupt(): Promise<void> {
    if (!this.connected) return;
    // Set the abort flag first — receiveAudio() checks this at the top of
    // each iteration, so even if the resolver wake-up races it, the flag
    // will be seen on the next loop pass.
    this._interruptPending = true;
    // Wake any in-flight dequeue() so it delivers the sentinel immediately
    // rather than waiting for the next real message (which could be seconds
    // away on a long Gemini turn). Atomically take the resolver to avoid a
    // double-resolve if enqueue() fires at the same time.
    const resolver = this.resolveNext;
    this.resolveNext = null;
    resolver?.({ interrupted: true });
  }

  // ------------------------------------------------------------- internal

  private requireConnected(): void {
    if (!this.connected || !this.session) {
      throw new Error("GeminiLiveAgentAdapter: not connected");
    }
  }

  private enqueue(item: QueueItem): void {
    if (this.resolveNext) {
      const resolver = this.resolveNext;
      this.resolveNext = null;
      resolver(item);
      return;
    }
    this.queue.push(item);
  }

  /**
   * Pull the next queued item, waiting up to `timeoutMs` milliseconds.
   * Throws a TimeoutError-named Error on expiry.
   */
  private dequeue(timeoutMs: number): Promise<QueueItem> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);

    return new Promise<QueueItem>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Detach the pending resolver if we're the active waiter.
        if (this.resolveNext === wrapped) this.resolveNext = null;
        const err = new Error(
          `GeminiLiveAgentAdapter: no message within ${timeoutMs}ms`,
        );
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);

      const wrapped = (item: QueueItem): void => {
        clearTimeout(timer);
        resolve(item);
      };
      this.resolveNext = wrapped;
    });
  }
}
