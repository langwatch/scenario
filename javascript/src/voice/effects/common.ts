/**
 * Shared helpers for effect implementations. PCM16 @ 24kHz mono bytes <-> Int16Array.
 *
 * TS equivalent of `python/scenario/voice/effects/_common.py`.
 */

import { PCM16_SAMPLE_RATE } from "../audio-chunk";

/** An effect function: takes PCM16 bytes and returns PCM16 bytes. */
export type EffectFn = (audio: Uint8Array) => Uint8Array;

/**
 * Copy PCM16 bytes into a fresh Int16Array.
 *
 * Little-endian; on all supported platforms (Node ≥ 20, x86_64/arm64)
 * Int16Array is host-endian == LE, so a direct view is sufficient.
 */
export function pcm16ToInt16(b: Uint8Array): Int16Array {
  // Ensure 2-byte alignment for Int16Array view.
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Int16Array(buf);
}

/**
 * Convert an Int16Array (or Float32Array) back to PCM16 Uint8Array.
 * Clips values to [-32768, 32767] before casting.
 */
export function int16ToPcm16(arr: Int16Array | Float32Array): Uint8Array {
  const out = new Int16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    // Clip to int16 range
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return new Uint8Array(out.buffer);
}

/** Returns the PCM16 sample rate constant (24000 Hz). */
export function rate(): number {
  return PCM16_SAMPLE_RATE;
}

/**
 * Linear-index resample of an Int16Array to a new length.
 * Matches Python's `np.linspace(0, len-1, newLen).astype(int64)` index gather.
 */
export function linearResample(arr: Int16Array, newLen: number): Int16Array {
  if (newLen <= 0 || arr.length === 0) return new Int16Array(0);
  const out = new Int16Array(newLen);
  const denom = newLen - 1 || 1;
  for (let i = 0; i < newLen; i++) {
    const idx = Math.min(arr.length - 1, Math.floor((i * (arr.length - 1)) / denom));
    out[i] = arr[idx];
  }
  return out;
}
