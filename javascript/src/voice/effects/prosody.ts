/**
 * Prosody effects: volume scaling and time-stretching speech.
 *
 * TS equivalent of `python/scenario/voice/effects/prosody.py`.
 */

import { EffectFn, int16ToPcm16, linearResample, pcm16ToInt16 } from "./common";

/**
 * Scale amplitude down by `factor` (0 < factor <= 1).
 */
export function lowVolume(factor = 0.5): EffectFn {
  if (factor <= 0) throw new Error("lowVolume factor must be > 0");

  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i] * factor;
    }
    return int16ToPcm16(out);
  };
}

/**
 * Scale amplitude up by `factor` (>= 1). Clips at int16 bounds.
 */
export function highVolume(factor = 1.5): EffectFn {
  if (factor < 1) throw new Error("highVolume factor must be >= 1");

  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i] * factor;
    }
    return int16ToPcm16(out);
  };
}

/**
 * Time-stretch to speak faster (factor > 1). Linear resample — pitch shifts.
 */
export function speakingFast(factor = 1.3): EffectFn {
  if (factor <= 1) throw new Error("speakingFast factor must be > 1");
  return _resampleFactor(factor);
}

/**
 * Time-stretch to speak slower (factor < 1). Same pitch tradeoff as speakingFast.
 */
export function speakingSlow(factor = 0.7): EffectFn {
  if (factor >= 1) throw new Error("speakingSlow factor must be < 1");
  return _resampleFactor(factor);
}

/** Internal: time-stretch via linear-index resample. */
function _resampleFactor(factor: number): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    if (arr.length === 0) return audio;

    const newLen = Math.max(1, Math.round(arr.length / factor));
    const resampled = linearResample(arr, newLen);
    return new Uint8Array(resampled.buffer, resampled.byteOffset, resampled.byteLength);
  };
}
