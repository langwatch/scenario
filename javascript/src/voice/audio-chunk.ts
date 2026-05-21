/**
 * AudioChunk — the canonical internal audio representation.
 *
 * Per the AudioChunk normalization locked decision (Python parity: see
 * `python/scenario/voice/audio_chunk.py`), every piece of audio flowing
 * through the SDK is PCM16 @ 24kHz mono at the framework boundary. Adapters
 * convert to/from their transport-native format at the send/recv edge.
 *
 * This keeps the combinatorial complexity of N adapters x M formats
 * collapsed to N conversions at the adapter edge.
 */

export const PCM16_SAMPLE_RATE = 24000;
export const PCM16_CHANNELS = 1;
export const PCM16_SAMPLE_WIDTH_BYTES = 2;

export interface AudioChunkInit {
  /** Raw PCM16 little-endian bytes, mono, sample rate = 24000 Hz. */
  data: Uint8Array;
  /** Optional transcript text (may be populated by streaming STT). */
  transcript?: string;
  /** Optional wall-clock offset from scenario start, in seconds. */
  startTime?: number;
  /** Optional wall-clock offset from scenario start, in seconds. */
  endTime?: number;
}

/**
 * A chunk of audio in the canonical internal format: PCM16, 24kHz, mono.
 *
 * Enforces the PCM16 odd-byte invariant at construction — partial-sample
 * buffers (length not a multiple of 2) cause silent off-by-one drift in
 * downstream consumers, so we catch them at the canonical boundary.
 */
export class AudioChunk {
  readonly data: Uint8Array;
  readonly transcript?: string;
  readonly startTime?: number;
  readonly endTime?: number;

  constructor(init: AudioChunkInit) {
    if (init.data.length % PCM16_SAMPLE_WIDTH_BYTES !== 0) {
      throw new Error(
        `AudioChunk.data length (${init.data.length} bytes) is not a ` +
          `multiple of ${PCM16_SAMPLE_WIDTH_BYTES} — not valid PCM16. ` +
          "This usually indicates a partial transport frame; adapters " +
          "must buffer until a complete sample is available.",
      );
    }
    this.data = init.data;
    this.transcript = init.transcript;
    this.startTime = init.startTime;
    this.endTime = init.endTime;
  }

  get sampleRate(): number {
    return PCM16_SAMPLE_RATE;
  }

  get channels(): number {
    return PCM16_CHANNELS;
  }

  /** Length of the chunk in seconds (from bytes, assuming PCM16 mono). */
  get durationSeconds(): number {
    if (this.data.length === 0) return 0;
    const numSamples = Math.floor(this.data.length / PCM16_SAMPLE_WIDTH_BYTES);
    return numSamples / PCM16_SAMPLE_RATE;
  }
}

/** Generate a PCM16 silent AudioChunk of the given duration. */
export function silentChunk(durationSeconds: number): AudioChunk {
  const numSamples = Math.floor(durationSeconds * PCM16_SAMPLE_RATE);
  const data = new Uint8Array(numSamples * PCM16_SAMPLE_WIDTH_BYTES);
  return new AudioChunk({ data });
}
