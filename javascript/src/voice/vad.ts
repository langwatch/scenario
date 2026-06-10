/**
 * Voice-activity detection fallback for adapters without native VAD.
 *
 * Python parity: `python/scenario/voice/vad.py`. Activates only when an
 * adapter publishes `capabilities.nativeVad === false`; emits a single
 * `UserWarning`-equivalent per adapter on first activation so users know
 * the fallback is in effect (no rate-limit regression — see the Python
 * commit history for the bug class).
 *
 * ## Detection algorithm
 *
 * PR3 ships a pure-TypeScript RMS-energy + hysteresis detector over PCM16
 * @ 24 kHz frames. This is the SMALLEST VIABLE PATH to land the runtime
 * with VAD fallback working — see the `## Decision pending: webrtcvad
 * build pipeline` section in PR3 for the longer-term `webrtcvad` C
 * library options (WASM committed blob recommended). The contract
 * surface (`process(chunk)` → `onSpeechStart`/`onSpeechEnd`, one-shot
 * warning) does not change with the underlying detector.
 */
import { AudioChunk, PCM16_SAMPLE_RATE } from "./audio-chunk";

/** Frame size in milliseconds — matches Python `vad.py` for parity. */
const FRAME_MS = 30;

/** PCM16 samples per 30 ms frame at the canonical 24 kHz rate. */
const SAMPLES_PER_FRAME = (PCM16_SAMPLE_RATE * FRAME_MS) / 1000;

/** Byte length of one 30 ms PCM16 frame (samples × 2 bytes). */
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

/**
 * RMS threshold above which a frame is considered speech.
 *
 * PCM16 ranges over [-32768, 32767]; an RMS of ~500 corresponds to roughly
 * -36 dBFS — a conservative floor that admits normal speech while
 * rejecting most ambient noise. Tuneable via the `rmsThreshold` constructor
 * option for adapters that need more or less sensitivity.
 */
const DEFAULT_RMS_THRESHOLD = 500;

/**
 * Consecutive same-state frames required to flip the speaking state.
 * Mirrors the hysteresis pattern Python's `webrtcvad` wrapper relies on
 * via its aggressiveness level — flicker rejection at the SDK layer.
 */
const DEFAULT_HYSTERESIS_FRAMES = 3;

export interface WebRTCVadFallbackOptions {
  /**
   * Override the default RMS threshold (raw amplitude over PCM16 samples).
   * Default: {@link DEFAULT_RMS_THRESHOLD}.
   */
  rmsThreshold?: number;
  /**
   * Override the hysteresis frame count. Default:
   * {@link DEFAULT_HYSTERESIS_FRAMES}.
   */
  hysteresisFrames?: number;
  /** Fires when speech is detected (after hysteresis). */
  onSpeechStart?: () => void;
  /** Fires when silence is detected after speech (after hysteresis). */
  onSpeechEnd?: () => void;
}

/**
 * Incremental VAD over PCM16 @ 24 kHz mono audio.
 *
 * Feed chunks via {@link process}; the configured `onSpeechStart` /
 * `onSpeechEnd` callbacks fire when the speech/silence transitions
 * stabilise. The detector is purely sample-driven — no async, no timers
 * — so a single instance is safe to share across an entire scenario as
 * long as one adapter feeds it.
 */
export class WebRTCVadFallback {
  /** Per-process warning memoisation — one warning per adapter name. */
  private static warnedAdapters = new Set<string>();

  /**
   * Reset the per-process warning memoisation. Tests call this in
   * `beforeEach` so the one-shot-warning assertion is reproducible
   * across runs.
   */
  static resetWarnings(): void {
    WebRTCVadFallback.warnedAdapters = new Set<string>();
  }

  /**
   * Emit the SDK-side VAD fallback warning at most once per adapter name.
   *
   * Routes via `console.warn` (no `process.emitWarning` so the contract
   * holds in browser-like runtimes too). The warning text references
   * accuracy differences vs native VAD, matching the Python `UserWarning`
   * surface at `vad.py:50`.
   */
  private static emitFallbackWarningOnce(adapterName: string): void {
    if (WebRTCVadFallback.warnedAdapters.has(adapterName)) {
      return;
    }
    WebRTCVadFallback.warnedAdapters.add(adapterName);
    console.warn(
      `[scenario.voice] Adapter '${adapterName}' has no native VAD — ` +
        "using SDK-side VAD fallback. Accuracy may differ from native VAD.",
    );
  }

  private readonly rmsThreshold: number;
  private readonly hysteresisFrames: number;
  private readonly onSpeechStart: () => void;
  private readonly onSpeechEnd: () => void;
  private speaking = false;
  private buf: number[] = [];
  /** Count of consecutive frames in the candidate state (speech or silence). */
  private candidateRun = 0;
  /** The candidate state being voted on by the run counter. */
  private candidateState = false;

  constructor(adapterName: string, options: WebRTCVadFallbackOptions = {}) {
    WebRTCVadFallback.emitFallbackWarningOnce(adapterName);
    this.rmsThreshold = options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    this.hysteresisFrames =
      options.hysteresisFrames ?? DEFAULT_HYSTERESIS_FRAMES;
    this.onSpeechStart = options.onSpeechStart ?? (() => undefined);
    this.onSpeechEnd = options.onSpeechEnd ?? (() => undefined);
  }

  /** True once the hysteresis has flipped the state to speech. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Feed audio into the detector. The configured callbacks fire on
   * speech↔silence transitions after hysteresis stabilises.
   */
  process(chunk: AudioChunk): void {
    const data = chunk.data;
    for (let i = 0; i < data.length; i++) {
      this.buf.push(data[i]!);
    }
    while (this.buf.length >= BYTES_PER_FRAME) {
      const frame = this.buf.slice(0, BYTES_PER_FRAME);
      this.buf.splice(0, BYTES_PER_FRAME);
      const isSpeech = this.classifyFrame(frame);
      this.observe(isSpeech);
    }
  }

  /**
   * RMS energy classification of a 30 ms PCM16 frame. Pure function over
   * the byte slice — no IO, no allocation outside the loop.
   */
  private classifyFrame(frame: number[]): boolean {
    let sumSquares = 0;
    const sampleCount = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      // little-endian PCM16 → signed int16
      const lo = frame[i]!;
      const hi = frame[i + 1]!;
      let sample = (hi << 8) | lo;
      if (sample & 0x8000) {
        sample = sample - 0x10000;
      }
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    return rms >= this.rmsThreshold;
  }

  /**
   * Apply hysteresis: only flip {@link speaking} after the candidate
   * state holds for {@link hysteresisFrames} consecutive frames.
   */
  private observe(isSpeech: boolean): void {
    if (isSpeech === this.candidateState) {
      this.candidateRun += 1;
    } else {
      this.candidateState = isSpeech;
      this.candidateRun = 1;
    }
    if (this.candidateRun < this.hysteresisFrames) {
      return;
    }
    if (this.candidateState && !this.speaking) {
      this.speaking = true;
      this.onSpeechStart();
    } else if (!this.candidateState && this.speaking) {
      this.speaking = false;
      this.onSpeechEnd();
    }
  }
}
