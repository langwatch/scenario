/**
 * Noise-class effects: backgroundNoise, static_, multipleVoices.
 *
 * TS equivalent of `python/scenario/voice/effects/noise.py`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EffectFn, int16ToPcm16, linearResample, pcm16ToInt16, rate } from "./common";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the bundled noise assets, in priority order. The
 * relative path from the COMPILED module to `voice/assets/noise` differs by
 * layout — the unbundled source has this file at `src/voice/effects/` (so
 * `../assets/noise` is correct), but tsup BUNDLES everything into `dist/
 * index.mjs` (so `HERE` is `dist/` and the assets, copied by the build to
 * `dist/voice/assets/noise`, are at `./voice/assets/noise`). Probing both —
 * plus the published-package `src/voice/assets/noise` (shipped via `files`) —
 * makes asset loading robust to all three layouts instead of silently
 * returning empty audio (which made `backgroundNoise` a no-op in the bundled
 * build — issue #372 demo fix).
 */
const ASSETS_DIR_CANDIDATES = [
  resolve(HERE, "..", "assets", "noise"), // src layout: src/voice/effects/ → src/voice/assets/noise
  resolve(HERE, "voice", "assets", "noise"), // bundled: dist/ → dist/voice/assets/noise
  resolve(HERE, "..", "voice", "assets", "noise"), // dist/<sub>/ → dist/voice/assets/noise
  resolve(HERE, "..", "..", "src", "voice", "assets", "noise"), // published pkg src/ copy
];

/** Resolve a bundled asset by probing the candidate dirs; first hit wins. */
function resolveAssetPath(name: string): string | null {
  for (const dir of ASSETS_DIR_CANDIDATES) {
    const candidate = resolve(dir, `${name}.wav`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Built-in presets. "babble" is NOT a background_noise preset — it is the
// sample used by multipleVoices only (see §4.5 source comment in Python).
const BACKGROUND_PRESETS = new Set(["cafe", "street", "office", "airport"]);

// ---------------------------------------------------------------------------
// WAV loading helpers
// ---------------------------------------------------------------------------

/**
 * Parse a minimal WAV buffer (PCM16, any channels, any sample rate) and
 * return a mono Int16Array resampled to 24kHz.
 *
 * Only 16-bit PCM WAVs are supported (sampleWidth == 2). All bundled assets
 * meet this requirement.
 */
function wavToInt16(buf: Uint8Array): Int16Array {
  // WAV header: RIFF, WAVE, fmt chunk, data chunk
  // We parse just enough to extract: channels, sampleRate, sampleWidth, PCM data.
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Verify RIFF magic
  const riff = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (riff !== "RIFF") return new Int16Array(0);

  // WAVE identifier at offset 8
  const wave = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (wave !== "WAVE") return new Int16Array(0);

  let offset = 12;
  let channels = 1;
  let sampleRate = 24000;
  let sampleWidth = 2;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = String.fromCharCode(
      dv.getUint8(offset),
      dv.getUint8(offset + 1),
      dv.getUint8(offset + 2),
      dv.getUint8(offset + 3),
    );
    const chunkSize = dv.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      // audioFormat at offset+8 (1 = PCM)
      channels = dv.getUint16(offset + 10, true);
      sampleRate = dv.getUint32(offset + 12, true);
      // blockAlign at offset+20, bitsPerSample at offset+22
      const bitsPerSample = dv.getUint16(offset + 22, true);
      sampleWidth = bitsPerSample / 8;
    } else if (chunkId === "data") {
      dataStart = offset + 8;
      dataLen = chunkSize;
    }

    offset += 8 + chunkSize;
    // Some WAVs have odd-size chunks; round up
    if (chunkSize % 2 !== 0) offset++;
  }

  if (dataStart < 0 || sampleWidth !== 2) return new Int16Array(0);

  // Extract raw PCM16 samples
  const rawBytes = buf.slice(dataStart, dataStart + dataLen);
  const rawSamples = new Int16Array(rawBytes.buffer, rawBytes.byteOffset, Math.floor(rawBytes.byteLength / 2));

  // Mono-mix if stereo (or more channels)
  let mono: Int16Array;
  if (channels === 1) {
    mono = rawSamples;
  } else {
    const frameCount = Math.floor(rawSamples.length / channels);
    mono = new Int16Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += rawSamples[i * channels + c];
      }
      mono[i] = Math.round(sum / channels);
    }
  }

  // Resample to 24kHz if needed — linear index interpolation (matches Python's np.linspace approach)
  const targetRate = rate();
  if (sampleRate === targetRate) return mono;

  const newLen = Math.max(1, Math.round((mono.length * targetRate) / sampleRate));
  return linearResample(mono, newLen);
}

/** One-time warning gate so a missing asset surfaces once, not per chunk. */
const warnedMissing = new Set<string>();

/**
 * Load a bundled WAV asset by name (without .wav extension). Returns an empty
 * Int16Array if the asset cannot be located/parsed — but emits a ONE-TIME
 * warning for a known preset so a broken build/asset path is LOUD (it used to
 * silently make `backgroundNoise` a no-op in the bundled dist — issue #372).
 */
function loadSample(name: string): Int16Array {
  const path = resolveAssetPath(name);
  if (path === null) {
    if (!warnedMissing.has(name)) {
      warnedMissing.add(name);
      console.warn(
        `[scenario.voice] noise asset ${JSON.stringify(name)}.wav not found ` +
          `(searched ${ASSETS_DIR_CANDIDATES.join(", ")}); this effect is a ` +
          "no-op. The bundled assets ship under dist/voice/assets/noise — check " +
          "the build's asset-copy step.",
      );
    }
    return new Int16Array(0);
  }
  try {
    const buf = readFileSync(path);
    return wavToInt16(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return new Int16Array(0);
  }
}

// ---------------------------------------------------------------------------
// Public effects
// ---------------------------------------------------------------------------

/**
 * Overlay ambient noise.
 *
 * `presetOrPath` is one of the built-in presets ("cafe", "street", "office",
 * "airport") or a filesystem path to a WAV file (must contain `/`, `\`, or
 * end with `.wav`).
 */
export function backgroundNoise(presetOrPath: string, volume = 0.3): EffectFn {
  let sample: Int16Array;

  if (BACKGROUND_PRESETS.has(presetOrPath)) {
    sample = loadSample(presetOrPath);
  } else {
    const looksLikePath =
      presetOrPath.includes("/") ||
      presetOrPath.includes("\\") ||
      presetOrPath.toLowerCase().endsWith(".wav");

    if (!looksLikePath) {
      throw new Error(
        `backgroundNoise: preset ${JSON.stringify(presetOrPath)} is not one of ` +
          `${JSON.stringify(Array.from(BACKGROUND_PRESETS).sort())}. To load a custom WAV pass a ` +
          "path containing a separator or ending with .wav.",
      );
    }
    const buf = readFileSync(presetOrPath);
    sample = wavToInt16(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }

  return function _apply(audio: Uint8Array): Uint8Array {
    const signal = pcm16ToInt16(audio);
    if (sample.length === 0 || signal.length === 0) return audio;

    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      const noiseIdx = i % sample.length;
      out[i] = signal[i] + sample[noiseIdx] * volume;
    }
    return int16ToPcm16(out);
  };
}

/**
 * Overlay white-noise static at the given intensity (fraction of full scale).
 */
export function static_(intensity = 0.05): EffectFn {
  return function _apply(audio: Uint8Array): Uint8Array {
    const signal = pcm16ToInt16(audio);
    if (signal.length === 0) return audio;

    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      // Box-Muller-free approximation: (Math.random() - 0.5) * 2 gives uniform
      // [-1, 1]; close enough for noise generation.
      const noise = (Math.random() - 0.5) * 2 * 32767 * intensity;
      out[i] = signal[i] + noise;
    }
    return int16ToPcm16(out);
  };
}

/**
 * Mix with a babble speech sample to simulate background conversation.
 * Uses the bundled `babble.wav` by default, or reads from `backgroundAudio` path.
 *
 * `volume` scales the babble gain (default 0.3) — symmetric with
 * {@link backgroundNoise} (review n1). NOTE: the Python twin
 * (`python/scenario/voice/effects/noise.py:multiple_voices`) does not yet expose
 * this param; the default preserves identical behaviour, and adding the same
 * `volume` arg to Python is a tracked parity follow-up (out of scope for this
 * JS-only pass).
 */
export function multipleVoices(
  backgroundAudio?: string,
  volume = 0.3,
): EffectFn {
  let sample: Int16Array;
  if (backgroundAudio == null) {
    sample = loadSample("babble");
  } else {
    const buf = readFileSync(backgroundAudio);
    sample = wavToInt16(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }

  return function _apply(audio: Uint8Array): Uint8Array {
    const signal = pcm16ToInt16(audio);
    if (sample.length === 0 || signal.length === 0) return audio;

    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      const babbleIdx = i % sample.length;
      out[i] = signal[i] + sample[babbleIdx] * volume;
    }
    return int16ToPcm16(out);
  };
}
