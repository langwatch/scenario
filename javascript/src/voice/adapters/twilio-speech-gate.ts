/**
 * TwilioSpeechGate — energy-gated admission of INBOUND call audio.
 *
 * Twilio Media Streams deliver a `media` frame every 20 ms for the whole life
 * of the call, silence included (the far end's comfort noise and line noise
 * are audio too, and Twilio does no speech detection of its own on a raw
 * `<Connect><Stream>`; the protocol carries no speech/silence event at all).
 * The shared drain (`adapter.runtime.ts` `drainAgentResponse`) decides "the
 * agent finished talking" by a GAP IN CHUNK ARRIVAL of `responseTailSilence`
 * seconds — a signal that can never occur on a phone line where chunks keep
 * arriving through every pause. Without this gate the callee's turn only ends
 * when the callee hangs up (terminal chunk) or the drain's hard ceiling fires,
 * which is exactly the "callee says hello? are you still there? for 40 s and
 * the simulated caller never gets its second turn" failure seen on real calls.
 *
 * The gate sits between the media loop and the inbound queue: chunks are
 * admitted only while the far end is speaking (RMS energy over the chunk at or
 * above `rmsThreshold`), plus a short `hangoverMs` after energy drops so
 * intra-sentence gaps do not split an utterance, plus a `prerollMs` of the
 * quiet chunks that preceded the onset so the first syllable is not clipped.
 * Everything else is dropped BEFORE it reaches the queue, so the drain sees a
 * genuine arrival gap once the callee stops and closes the turn on its normal
 * tail-silence path — no change to the shared drain, no new turn-end signal.
 *
 * The terminal sentinel (an empty chunk) is always passed through untouched;
 * it is the media loop's end-of-call signal, not audio.
 *
 * Python parity: none yet — `python/scenario/voice/adapters/_twilio_server.py`
 * has the same gap; tracked as a follow-up issue.
 */

import { AudioChunk } from "../audio-chunk";

/**
 * RMS (int16 scale) at or above which a chunk counts as speech.
 *
 * Measured on a real Twilio a-leg call against an ElevenLabs callee (100 ms
 * windows, int16 scale after the SDK's own µ-law→PCM16 24 kHz path, which
 * applies no gain): between-utterance noise p95 ≈ 740 (-33 dBFS), speech p10 ≈
 * 940 (-31 dBFS), p50 ≈ 1380 (-27.5 dBFS). The margin is thin, which is why the
 * gate ALSO needs {@link DEFAULT_SPEECH_GATE_HANGOVER_MS}: speech dips under the
 * threshold for up to ~200 ms on plosives and breaths, and a bare threshold
 * would split one utterance into hundreds of fragments. Tune via
 * `speechGate.rmsThreshold` on the adapter options.
 */
export const DEFAULT_SPEECH_GATE_RMS_THRESHOLD = 800;

/**
 * How long, after energy drops below the threshold, chunks keep being admitted.
 * Covers the short gaps inside a sentence (breaths, commas) so they do not
 * become an arrival gap. The drain's `responseTailSilence` then runs AFTER this,
 * so the effective pause a callee may take mid-turn is `hangoverMs +
 * responseTailSilence`.
 */
export const DEFAULT_SPEECH_GATE_HANGOVER_MS = 400;

/**
 * How much of the quiet immediately BEFORE an onset is replayed ahead of the
 * first speech chunk, so a soft first syllable that did not clear the threshold
 * on its own is still recorded and heard by the drain.
 */
export const DEFAULT_SPEECH_GATE_PREROLL_MS = 300;

export interface TwilioSpeechGateOptions {
  /** Default: {@link DEFAULT_SPEECH_GATE_RMS_THRESHOLD}. */
  rmsThreshold?: number;
  /** Default: {@link DEFAULT_SPEECH_GATE_HANGOVER_MS}. */
  hangoverMs?: number;
  /** Default: {@link DEFAULT_SPEECH_GATE_PREROLL_MS}. */
  prerollMs?: number;
}

/** RMS of little-endian PCM16 samples, on the int16 scale (0..32767). */
export function pcm16Rms(data: Uint8Array): number {
  const sampleCount = data.length >> 1;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    let sample = ((data[i + 1] ?? 0) << 8) | (data[i] ?? 0);
    if (sample & 0x8000) sample -= 0x10000;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export class TwilioSpeechGate {
  private readonly rmsThreshold: number;
  private readonly hangoverMs: number;
  private readonly prerollMs: number;

  private speaking = false;
  private silentMs = 0;
  private preroll: AudioChunk[] = [];
  private prerollHeldMs = 0;

  /** Chunks dropped as silence over the gate's lifetime (telemetry). */
  droppedChunks = 0;
  /** Milliseconds of audio dropped as silence over the gate's lifetime. */
  droppedMs = 0;
  /** Number of speech onsets admitted (≈ utterances heard). */
  onsets = 0;

  constructor(options: TwilioSpeechGateOptions = {}) {
    this.rmsThreshold = options.rmsThreshold ?? DEFAULT_SPEECH_GATE_RMS_THRESHOLD;
    this.hangoverMs = options.hangoverMs ?? DEFAULT_SPEECH_GATE_HANGOVER_MS;
    this.prerollMs = options.prerollMs ?? DEFAULT_SPEECH_GATE_PREROLL_MS;
  }

  /** True while the far end is (or was within the hangover) speaking. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Forget the per-call state (speaking flag, hangover, held pre-roll). The
   *  lifetime counters are left alone so a disconnect-time stamp still sees
   *  the whole call. */
  reset(): void {
    this.speaking = false;
    this.silentMs = 0;
    this.preroll = [];
    this.prerollHeldMs = 0;
  }

  /** Zero the lifetime counters as well — a fresh connection. */
  resetCounters(): void {
    this.reset();
    this.droppedChunks = 0;
    this.droppedMs = 0;
    this.onsets = 0;
  }

  /**
   * Decide what reaches the queue for one incoming chunk: `[]` (dropped as
   * silence), `[chunk]`, or `[...preroll, chunk]` at a speech onset.
   */
  admit(chunk: AudioChunk): AudioChunk[] {
    // The media loop's end-of-call sentinel: not audio, never gated. Any
    // pre-roll still held is silence and is discarded with the call.
    if (chunk.data.length === 0) {
      this.reset();
      return [chunk];
    }
    const chunkMs = chunk.durationSeconds * 1000;
    const isSpeech = pcm16Rms(chunk.data) >= this.rmsThreshold;

    if (this.speaking) {
      if (isSpeech) {
        this.silentMs = 0;
        return [chunk];
      }
      this.silentMs += chunkMs;
      if (this.silentMs <= this.hangoverMs) return [chunk];
      // Hangover elapsed: the utterance is over. This chunk starts the next
      // pre-roll window instead of reaching the queue.
      this.speaking = false;
      this.silentMs = 0;
      this.hold(chunk, chunkMs);
      return [];
    }

    if (!isSpeech) {
      this.hold(chunk, chunkMs);
      return [];
    }

    // Onset: replay the held pre-roll ahead of the first speech chunk.
    this.speaking = true;
    this.silentMs = 0;
    this.onsets += 1;
    const admitted = [...this.preroll, chunk];
    // The pre-roll is being delivered after all, so it was not dropped.
    this.droppedChunks -= this.preroll.length;
    this.droppedMs -= this.prerollHeldMs;
    this.preroll = [];
    this.prerollHeldMs = 0;
    return admitted;
  }

  /** Keep `chunk` in the bounded pre-roll window; count it as dropped for now. */
  private hold(chunk: AudioChunk, chunkMs: number): void {
    this.droppedChunks += 1;
    this.droppedMs += chunkMs;
    this.preroll.push(chunk);
    this.prerollHeldMs += chunkMs;
    while (this.prerollHeldMs > this.prerollMs) {
      const evicted = this.preroll.shift();
      if (!evicted) break;
      this.prerollHeldMs -= evicted.durationSeconds * 1000;
    }
  }
}
