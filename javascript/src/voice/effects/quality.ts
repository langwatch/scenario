/**
 * Quality-degradation effects: phoneQuality, lowQuality, packetLoss, echo, robotic, breakingUp.
 *
 * TS equivalent of `python/scenario/voice/effects/quality.py`.
 */

import FFT from "fft.js";

import { EffectFn, int16ToPcm16, linearResample, pcm16ToInt16, rate } from "./common";

/** Returns the next power of two >= n. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ---------------------------------------------------------------------------
// phoneQuality
// ---------------------------------------------------------------------------

/**
 * Bandpass 300Hz–3.4kHz via FFT + tanh compression to mimic a phone line.
 */
export function phoneQuality(): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    if (arr.length === 0) return audio;

    const n = arr.length;
    const fftSize = nextPow2(n);
    const fft = new FFT(fftSize);

    // Zero-pad real input into the interleaved complex format expected by realTransform
    const realInput = new Array<number>(fftSize).fill(0);
    for (let i = 0; i < n; i++) realInput[i] = arr[i]!;

    // forward transform → complex array (interleaved: [re0, im0, re1, im1, ...])
    const spectrum = fft.createComplexArray();
    fft.realTransform(spectrum, realInput);

    // Fill the negative frequencies (realTransform only fills [0..fftSize/2])
    // by conjugate symmetry so inverseTransform works correctly.
    fft.completeSpectrum(spectrum);

    // Bandpass mask: keep bins whose frequency falls in [300, 3400] Hz
    const nyquist = rate() / 2;
    const binCount = fftSize; // number of complex pairs in full spectrum
    for (let bin = 0; bin < binCount; bin++) {
      const freq = (bin * nyquist) / (binCount / 2);
      if (freq < 300 || freq > 3400) {
        spectrum[bin * 2] = 0;
        spectrum[bin * 2 + 1] = 0;
      }
    }

    // Inverse transform
    const reconstructed = fft.createComplexArray();
    fft.inverseTransform(reconstructed, spectrum);

    // Extract real parts, truncate to original length
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      filtered[i] = reconstructed[i * 2]!;
    }

    // Mild tanh compression
    for (let i = 0; i < n; i++) {
      filtered[i] = Math.tanh(filtered[i]! / 16000) * 16000;
    }

    return int16ToPcm16(filtered);
  };
}

// ---------------------------------------------------------------------------
// lowQuality
// ---------------------------------------------------------------------------

/**
 * Downsample to `bitrate` Hz and back — simulates a low-bitrate codec.
 */
export function lowQuality(bitrate = 8000): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    if (arr.length === 0 || bitrate >= rate()) return audio;

    const downLen = Math.max(1, Math.floor((arr.length * bitrate) / rate()));
    const down = linearResample(arr, downLen);
    const up = linearResample(down, arr.length);

    return new Uint8Array(up.buffer);
  };
}

// ---------------------------------------------------------------------------
// packetLoss
// ---------------------------------------------------------------------------

/**
 * Zero out random `chunkMs`-sized windows at the given `probability`.
 */
export function packetLoss(probability = 0.05, chunkMs = 20): EffectFn {
  if (probability < 0 || probability > 1) {
    throw new Error("packetLoss probability must be in [0, 1]");
  }

  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = new Int16Array(pcm16ToInt16(audio)); // copy
    if (arr.length === 0) return audio;

    const chunkSamples = Math.max(1, Math.floor((rate() * chunkMs) / 1000));
    for (let i = 0; i < arr.length; i += chunkSamples) {
      if (Math.random() < probability) {
        const end = Math.min(arr.length, i + chunkSamples);
        arr.fill(0, i, end);
      }
    }
    return new Uint8Array(arr.buffer);
  };
}

// ---------------------------------------------------------------------------
// echo
// ---------------------------------------------------------------------------

/**
 * Overlay a delayed/attenuated copy of the signal.
 */
export function echo(delayMs = 200, decay = 0.5): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    if (arr.length === 0) return audio;

    const delaySamples = Math.floor((rate() * delayMs) / 1000);
    if (delaySamples >= arr.length) return audio;

    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i]!;
      if (i >= delaySamples) {
        out[i] += arr[i - delaySamples]! * decay;
      }
    }
    return int16ToPcm16(out);
  };
}

// ---------------------------------------------------------------------------
// robotic
// ---------------------------------------------------------------------------

/**
 * Crude vocoder-ish effect: ring-modulate the signal with a 100 Hz carrier.
 */
export function robotic(): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const arr = pcm16ToInt16(audio);
    if (arr.length === 0) return audio;

    const out = new Float32Array(arr.length);
    const sr = rate();
    for (let i = 0; i < arr.length; i++) {
      const t = i / sr;
      const carrier = Math.sin(2 * Math.PI * 100 * t);
      out[i] = arr[i]! * carrier;
    }
    return int16ToPcm16(out);
  };
}

// ---------------------------------------------------------------------------
// breakingUp
// ---------------------------------------------------------------------------

/**
 * Simulate intermittent connection: 100ms chunks, 20% drop probability.
 */
export function breakingUp(): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    // Copy so we can zero in-place
    const arr = new Int16Array(pcm16ToInt16(audio));
    if (arr.length === 0) return audio;

    const chunkSamples = Math.floor((rate() * 100) / 1000); // 100ms windows
    for (let i = 0; i < arr.length; i += chunkSamples) {
      if (Math.random() < 0.2) {
        const end = Math.min(arr.length, i + chunkSamples);
        arr.fill(0, i, end);
      }
    }
    return new Uint8Array(arr.buffer);
  };
}
