/**
 * Generate the bundled CC0 ambient-noise samples for `backgroundNoise()` /
 * `multipleVoices()` (`src/voice/assets/noise/*.wav`).
 *
 * These are synthesised procedurally (no copyrighted source audio) and are
 * dedicated to the public domain under CC0 1.0. Generation is DETERMINISTIC
 * (a seeded LCG drives every random draw) so re-running this script
 * reproduces byte-identical WAVs — the assets are a checked-in artefact, this
 * script is how they were made.
 *
 * vs. the prior 0.5-second single-tone placeholders (`python/scripts/
 * generate_noise_samples.py`, which the TS assets were byte-copies of): each
 * preset here is THREE SECONDS of LAYERED, clearly-distinct, CONTINUOUS
 * ambience — broadband shaped noise + preset-characteristic structure (cafe
 * murmur + clinks, street rumble + passing vehicle, office HVAC hum +
 * keystrokes, airport crowd + PA bursts, multi-talker babble). Three seconds
 * means a single agent turn rarely tiles the loop point audibly; every preset
 * is audible from sample 0 and unmistakable by ear / in a spectrogram.
 *
 * Run from `javascript/`:
 *     node scripts/generate-noise-samples.mjs
 *
 * NOTE: the Python package ships the OLD 0.5-second placeholders at
 * `python/scenario/voice/assets/noise/*.wav` (byte-identical to what these
 * TS assets used to be). Porting this richer generator to Python is a
 * follow-up — this script only writes the TypeScript assets.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "src", "voice", "assets", "noise");

const SR = 24000; // 24 kHz mono PCM16 — the canonical effect sample rate.
const DURATION = 3.0; // seconds — long enough that a turn rarely tiles the loop.
const N = Math.floor(SR * DURATION);
// Normalise every preset to a common TARGET RMS (loudness) rather than to a
// common peak, so all presets are comparably AUDIBLE under a given
// `backgroundNoise(volume)`. PEAK_CLIP guards int16 headroom for mixing.
const TARGET_RMS = 4500;
const PEAK_CLIP = 14000;

/** Deterministic PRNG (mulberry32). Seeded per-preset → byte-stable assets. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform white noise in [-1, 1) from the seeded RNG. */
function white(rng, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = rng() * 2 - 1;
  return y;
}

/**
 * Boxcar (moving-average) smoother of width `w` samples — colours white noise
 * into a CONTINUOUS low/mid-frequency murmur while PRESERVING real amplitude
 * (a cascade of one-pole filters collapses zero-mean noise to ~0; a boxcar of
 * width w keeps rms ≈ white_rms/√w, i.e. genuinely audible). Larger w = darker.
 * Reflects at the edges so there is no silent attack.
 */
function smooth(x, w) {
  const n = x.length;
  const y = new Float64Array(n);
  if (w <= 1 || n === 0) {
    y.set(x);
    return y;
  }
  const half = Math.floor(w / 2);
  let acc = 0;
  // prime the window (reflected) so y[0] is already steady-state
  for (let k = -half; k <= w - 1 - half; k++) acc += x[Math.abs(k) % n];
  for (let i = 0; i < n; i++) {
    y[i] = acc / w;
    const out = Math.abs(i - half) % n;
    const inc = Math.abs(i + (w - half)) % n;
    acc += x[inc] - x[out];
  }
  return y;
}

/** Band-limited murmur: smooth (low-pass) of the difference of two smooths. */
function band(rng, n, wLow, wHigh) {
  const w = white(rng, n);
  const lo = smooth(w, wLow); // keeps freqs below ~SR/wLow
  const hi = smooth(w, wHigh); // keeps freqs below ~SR/wHigh
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = lo[i] - hi[i]; // band between the two
  return y;
}

/** Normalise to a target RMS, soft-clipping peaks above `peakClip`. */
function normalize(x, targetRms, peakClip) {
  let sumsq = 0;
  for (let i = 0; i < x.length; i++) sumsq += x[i] * x[i];
  const rms = Math.sqrt(sumsq / x.length) + 1e-9;
  const g = targetRms / rms;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * g;
    y[i] =
      Math.abs(v) <= peakClip
        ? v
        : Math.sign(v) * peakClip * Math.tanh(Math.abs(v) / peakClip);
  }
  return y;
}

function add(into, src, gain = 1) {
  for (let i = 0; i < into.length; i++) into[i] += src[i] * gain;
}

const t = (i) => i / SR;

// --------------------------------------------------------------------------
// Presets — each returns Float64 samples (un-normalised); main() normalises.
// All layers are CONTINUOUS (audible from sample 0) except sparse transients.
// --------------------------------------------------------------------------

/** Cafe: warm mid-band chatter murmur + slow swell + sparse cup clinks. */
function cafe() {
  const rng = makeRng(0xca5e_0001);
  const out = new Float64Array(N);
  // Continuous voice-band murmur (the chatter body). band() keeps real amplitude.
  const murmur = band(rng, N, 80, 8); // ~300 Hz..3 kHz body
  for (let i = 0; i < N; i++) {
    out[i] += murmur[i] * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.3 * t(i)));
  }
  // Darker room-tone bed underneath.
  add(out, smooth(white(rng, N), 160), 0.6);
  // Sparse high-frequency clinks (cups / cutlery) — short decaying pings.
  for (let k = 0; k < 6; k++) {
    const start = Math.floor(rng() * (N - SR * 0.2));
    const freq = 2500 + rng() * 2500;
    const len = Math.floor(SR * 0.08);
    for (let i = 0; i < len && start + i < N; i++) {
      out[start + i] += Math.sin(2 * Math.PI * freq * t(i)) * 0.6 * Math.exp(-18 * t(i));
    }
  }
  return out;
}

/** Street: deep traffic rumble + tyre hiss + a couple of passing-vehicle sweeps. */
function street() {
  const rng = makeRng(0x57ee_0002);
  const out = new Float64Array(N);
  // Deep continuous traffic rumble + an 80 Hz bed.
  add(out, smooth(white(rng, N), 300), 1.0);
  for (let i = 0; i < N; i++) out[i] += Math.sin(2 * Math.PI * 80 * t(i)) * 0.18;
  // Tyre/road hiss (brighter continuous band).
  add(out, band(rng, N, 12, 3), 0.35);
  // Two passing vehicles: amplitude bell + downward pitch doppler.
  for (const c of [0.9, 2.2]) {
    for (let i = 0; i < N; i++) {
      const dt = t(i) - c;
      const env = Math.exp(-(dt * dt) / (2 * 0.35 * 0.35));
      const f = 140 + 60 * Math.tanh(-dt * 2);
      out[i] += Math.sin(2 * Math.PI * f * t(i)) * 0.45 * env;
    }
  }
  return out;
}

/** Office: steady HVAC/mains hum (120 + 60 + 240 Hz) + faint air hiss + keystrokes. */
function office() {
  const rng = makeRng(0x0ff1_0003);
  const out = new Float64Array(N);
  // Continuous mains/HVAC hum bed.
  for (let i = 0; i < N; i++) {
    out[i] += Math.sin(2 * Math.PI * 120 * t(i)) * 0.5;
    out[i] += Math.sin(2 * Math.PI * 60 * t(i)) * 0.22;
    out[i] += Math.sin(2 * Math.PI * 240 * t(i)) * 0.13;
  }
  // Faint continuous broadband air-handling hiss.
  add(out, band(rng, N, 10, 2), 0.2);
  // Sparse keyboard clicks — short bright transients in bursts (typing).
  let k = 0;
  while (k < N) {
    k += Math.floor(SR * (0.08 + rng() * 0.22));
    if (k >= N) break;
    const len = Math.floor(SR * 0.012);
    const amp = 0.5 + rng() * 0.35;
    for (let i = 0; i < len && k + i < N; i++) {
      out[k + i] += (rng() * 2 - 1) * amp * Math.exp(-90 * t(i));
    }
  }
  return out;
}

/** Airport: big broadband crowd murmur + periodic band-limited PA bursts. */
function airport() {
  const rng = makeRng(0xa121_0004);
  const out = new Float64Array(N);
  // Large-hall crowd murmur — continuous mid-band with a slow swell.
  const crowd = band(rng, N, 60, 6);
  for (let i = 0; i < N; i++) out[i] += crowd[i] * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.2 * t(i) + 1));
  // Distant rolling-luggage / footfall low end.
  add(out, smooth(white(rng, N), 220), 0.45);
  // Periodic PA announcements: band-limited, syllabically-modulated bursts.
  const pa = band(rng, N, 30, 5); // ~telephone band
  for (const c of [0.7, 1.8, 2.6]) {
    for (let i = 0; i < N; i++) {
      const dt = t(i) - c;
      const env = Math.exp(-(dt * dt) / (2 * 0.18 * 0.18));
      const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t(i));
      out[i] += pa[i] * 0.9 * env * syl;
    }
  }
  return out;
}

/** Babble: many overlapping talkers — summed detuned syllabic-AM noise voices. */
function babble() {
  const rng = makeRng(0xbabb_0005);
  const out = new Float64Array(N);
  const voices = 6;
  for (let v = 0; v < voices; v++) {
    // Each "voice" = a vowel-band noise carrier, syllable-rate AM, own
    // rate/phase/centre so they don't lock together.
    const carrier = band(rng, N, 18 + Math.floor(rng() * 10), 3);
    const sylRate = 3 + rng() * 3; // 3-6 Hz syllable rate per talker
    const phase = rng() * Math.PI * 2;
    const gain = 0.7 + rng() * 0.5;
    for (let i = 0; i < N; i++) {
      const env = Math.max(0, Math.sin(2 * Math.PI * sylRate * t(i) + phase));
      out[i] += carrier[i] * env * gain;
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// WAV writer (PCM16 mono, canonical 44-byte header).
// --------------------------------------------------------------------------

function writeWav(path, samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(samples[i])));
  }
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
  return buf.length;
}

function rmsOf(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.round(Math.sqrt(sum / x.length));
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const presets = { cafe, street, office, airport, babble };
  for (const [name, fn] of Object.entries(presets)) {
    const samples = normalize(fn(), TARGET_RMS, PEAK_CLIP);
    const bytes = writeWav(resolve(OUT_DIR, `${name}.wav`), samples);
    const first = samples.subarray(0, Math.floor(SR * 0.5));
    console.log(
      `${name.padEnd(8)} ${(bytes / 1024).toFixed(1).padStart(6)} KiB  ` +
        `${DURATION}s  rms=${rmsOf(samples)}  first0.5s_rms=${rmsOf(first)}`,
    );
  }
  console.log(`Wrote ${Object.keys(presets).length} samples to ${OUT_DIR}`);
}

main();
