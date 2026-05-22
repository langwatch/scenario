/**
 * g711 µ-law + sample-rate-conversion unit tests for `twilio-shared.ts`.
 *
 * Binds two scenarios from `specs/voice-agents.feature` tagged
 * `@unit @ts-pipecat`:
 *  - "g711 µ-law encode/decode round-trip preserves audio fidelity"
 *  - "g711 sample rate conversion is correct in both directions"
 *
 * The codec is the load-bearing piece every Twilio-protocol adapter rides
 * on; if it drifts amplitude or warps frequencies, every voice scenario
 * silently degrades.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { describe, expect, it } from "vitest";

import { PCM16_SAMPLE_RATE } from "../../audio-chunk";
import {
  TWILIO_FRAME_BYTES,
  TWILIO_SAMPLE_RATE,
  iterMulawFrames,
  mulaw8kToPcm16At24k,
  mulawToPcm16,
  pcm16At24kToMulaw8k,
  pcm16ToMulaw,
  resamplePcm16,
} from "../twilio-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

/**
 * Synthesise a sine wave in PCM16 little-endian bytes. Amplitude ≤ 30000
 * keeps us below the µ-law clip threshold (32635) so the round-trip
 * error is bounded by quantisation, not saturation.
 */
function sinePcm16(opts: {
  durationSeconds: number;
  frequencyHz: number;
  sampleRate: number;
  amplitude?: number;
}): Uint8Array {
  const amplitude = opts.amplitude ?? 20000;
  const numSamples = Math.floor(opts.durationSeconds * opts.sampleRate);
  const bytes = new Uint8Array(numSamples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < numSamples; i++) {
    const t = i / opts.sampleRate;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * opts.frequencyHz * t));
    view.setInt16(i * 2, sample, true);
  }
  return bytes;
}

/** Read PCM16 LE bytes back into int16 samples. */
function pcm16Samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < Math.floor(bytes.length / 2); i++) {
    out.push(view.getInt16(i * 2, true));
  }
  return out;
}

/** RMS amplitude of a PCM16-decoded sample series. */
function rms(samples: number[]): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  return Math.sqrt(sumSq / samples.length);
}

/** Mean of a sample series — proxy for DC offset. */
function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "g711 µ-law encode/decode round-trip preserves audio fidelity",
      ({ Given, When, Then, And }) => {
        let inputPcm: Uint8Array;
        let decodedPcm: Uint8Array;

        Given("a PCM16 8 kHz sine wave at known amplitude", () => {
          inputPcm = sinePcm16({
            durationSeconds: 0.05,
            frequencyHz: 440,
            sampleRate: TWILIO_SAMPLE_RATE,
            amplitude: 20000,
          });
        });

        When("the buffer is encoded to µ-law and decoded back to PCM16", () => {
          const mulaw = pcm16ToMulaw(inputPcm);
          decodedPcm = mulawToPcm16(mulaw);
          expect(mulaw.length).toBe(inputPcm.length / 2);
          expect(decodedPcm.length).toBe(inputPcm.length);
        });

        Then(
          "the round-tripped samples match the input within G.711 quantisation error",
          () => {
            const inputSamples = pcm16Samples(inputPcm);
            const outputSamples = pcm16Samples(decodedPcm);
            expect(outputSamples.length).toBe(inputSamples.length);

            // The G.711 spec guarantees that the largest quantisation step
            // in the top segment is roughly 8 × bias ≈ 1056 for a 14-bit
            // magnitude scaled up to 16-bit; allow a comfortable margin
            // (8% of full-scale) so the test stays stable across the µ-law
            // segment boundaries the sine sweeps through.
            const FULL_SCALE = 32768;
            const TOLERANCE = FULL_SCALE * 0.08;
            let maxAbsErr = 0;
            for (let i = 0; i < inputSamples.length; i++) {
              const err = Math.abs(outputSamples[i] - inputSamples[i]);
              if (err > maxAbsErr) maxAbsErr = err;
            }
            expect(maxAbsErr).toBeLessThanOrEqual(TOLERANCE);
          },
        );

        And("amplitude is preserved within the per-segment µ-law step", () => {
          const inputRms = rms(pcm16Samples(inputPcm));
          const outputRms = rms(pcm16Samples(decodedPcm));
          // RMS amplitude after the lossy round trip should land within
          // ~10% of the input — looser than per-sample error because RMS
          // averages out quantisation noise.
          const ratio = outputRms / inputRms;
          expect(ratio).toBeGreaterThan(0.9);
          expect(ratio).toBeLessThan(1.1);
        });
      },
    );

    Scenario(
      "g711 sample rate conversion is correct in both directions",
      ({ Given, When, Then, And }) => {
        let inputPcm24k: Uint8Array;
        let downsampled8k: Uint8Array;
        let upsampled24k: Uint8Array;

        Given(
          "a PCM16 24 kHz buffer carrying a known low-frequency tone",
          () => {
            // 220 Hz is well below the 4 kHz Nyquist of 8 kHz so resampling
            // doesn't lose the fundamental — exercising the math, not
            // aliasing.
            inputPcm24k = sinePcm16({
              durationSeconds: 0.05,
              frequencyHz: 220,
              sampleRate: PCM16_SAMPLE_RATE,
              amplitude: 20000,
            });
          },
        );

        When(
          "the buffer is converted 24 kHz → 8 kHz → 24 kHz",
          () => {
            downsampled8k = resamplePcm16(
              inputPcm24k,
              PCM16_SAMPLE_RATE,
              TWILIO_SAMPLE_RATE,
            );
            upsampled24k = resamplePcm16(
              downsampled8k,
              TWILIO_SAMPLE_RATE,
              PCM16_SAMPLE_RATE,
            );
          },
        );

        Then(
          "the result is approximately 3× shorter then 3× longer",
          () => {
            const inputSamples = inputPcm24k.length / 2;
            const downsampledSamples = downsampled8k.length / 2;
            const upsampledSamples = upsampled24k.length / 2;
            // ±1 sample tolerance for round() boundary effects.
            expect(downsampledSamples).toBeGreaterThanOrEqual(
              Math.floor(inputSamples / 3) - 1,
            );
            expect(downsampledSamples).toBeLessThanOrEqual(
              Math.ceil(inputSamples / 3) + 1,
            );
            expect(upsampledSamples).toBeGreaterThanOrEqual(
              downsampledSamples * 3 - 1,
            );
            expect(upsampledSamples).toBeLessThanOrEqual(downsampledSamples * 3 + 1);
          },
        );

        And("no large amplitude or DC offset is introduced", () => {
          const inputRms = rms(pcm16Samples(inputPcm24k));
          const outputRms = rms(pcm16Samples(upsampled24k));
          // Linear interp slightly attenuates the high-frequency edges of
          // a sine, but for a 220 Hz tone at 24 kHz the loss is small.
          // 15% looseness keeps the test robust across phase alignments.
          const ratio = outputRms / inputRms;
          expect(ratio).toBeGreaterThan(0.85);
          expect(ratio).toBeLessThan(1.15);

          // DC offset proxy: the input is a zero-mean sine; resampling
          // shouldn't introduce a large DC bias.
          const inputDc = Math.abs(mean(pcm16Samples(inputPcm24k)));
          const outputDc = Math.abs(mean(pcm16Samples(upsampled24k)));
          expect(outputDc).toBeLessThan(inputDc + 200);
        });
      },
    );
  },
  { includeTags: [["unit", "ts-codec"]] },
);

// ---------------------------------------------------------------- plain unit tests
// Pure helpers + edge cases not worth a feature scenario but worth the safety net.

describe("twilio-shared codec edge cases", () => {
  it("encode + decode produce zero on silent PCM input", () => {
    const silence = new Uint8Array(160); // 80 PCM16 samples of zeros
    const mulaw = pcm16ToMulaw(silence);
    expect(mulaw.length).toBe(80);
    // µ-law of zero PCM ≈ 0xff (the complemented form). Exact value
    // depends on the BIAS, but every byte should be the same.
    const set = new Set(mulaw);
    expect(set.size).toBe(1);

    const back = mulawToPcm16(mulaw);
    const samples = pcm16Samples(back);
    // After decode + reverse-bias subtraction, silence comes back as 0.
    for (const s of samples) expect(Math.abs(s)).toBeLessThanOrEqual(1);
  });

  it("encode clips positive samples above the µ-law clip threshold", () => {
    // 32700 > clip threshold 32635 ⇒ should saturate, not wrap.
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt16(0, 32700, true);
    new DataView(bytes.buffer).setInt16(2, -32700, true);
    const mulaw = pcm16ToMulaw(bytes);
    const decoded = pcm16Samples(mulawToPcm16(mulaw));
    // Saturated positive sample decodes to something close to the
    // segment-7 top value (~32124), not a wrapped negative.
    expect(decoded[0]).toBeGreaterThan(30000);
    expect(decoded[1]).toBeLessThan(-30000);
  });

  it("iterMulawFrames yields 160-byte frames with a possibly-short tail", () => {
    const mulaw = new Uint8Array(170);
    for (let i = 0; i < mulaw.length; i++) mulaw[i] = i % 256;
    const frames = Array.from(iterMulawFrames(mulaw));
    expect(frames.length).toBe(2);
    expect(frames[0].length).toBe(TWILIO_FRAME_BYTES);
    expect(frames[1].length).toBe(10);
  });

  it("mulaw8kToPcm16At24k on empty input returns empty bytes", () => {
    expect(mulaw8kToPcm16At24k(new Uint8Array(0)).length).toBe(0);
  });

  it("pcm16At24kToMulaw8k on empty input returns empty bytes", () => {
    expect(pcm16At24kToMulaw8k(new Uint8Array(0)).length).toBe(0);
  });

  it("resamplePcm16 is a no-op when from == to", () => {
    const input = sinePcm16({
      durationSeconds: 0.01,
      frequencyHz: 440,
      sampleRate: 24000,
    });
    const out = resamplePcm16(input, 24000, 24000);
    expect(out).toBe(input);
  });
});
