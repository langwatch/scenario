/**
 * Unit tests for the inbound speech gate (`../twilio-speech-gate`): the pure
 * admit/drop decision, independent of sockets and the drain. The wrapper-level
 * proof that the gate actually lets the drain end a turn on a continuously
 * streaming line is `twilio-speech-gate-turn-end.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { AudioChunk, PCM16_SAMPLE_RATE } from "../../audio-chunk";
import {
  DEFAULT_SPEECH_GATE_RMS_THRESHOLD,
  TwilioSpeechGate,
  pcm16Rms,
} from "../twilio-speech-gate";

/** A PCM16 chunk of `ms` milliseconds whose samples all have `amplitude`. */
function tone(ms: number, amplitude: number): AudioChunk {
  const samples = Math.round((PCM16_SAMPLE_RATE * ms) / 1000);
  const data = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Alternate sign so the signal has no DC offset but a known RMS.
    const s = i % 2 === 0 ? amplitude : -amplitude;
    data[i * 2] = s & 0xff;
    data[i * 2 + 1] = (s >> 8) & 0xff;
  }
  return new AudioChunk({ data });
}

// From the measured dev call (see twilio-speech-gate.ts): speech p50 ≈ 1380,
// between-utterance noise p95 ≈ 740 on the int16 scale.
const SPEECH = 1380;
const NOISE = 740;

describe("pcm16Rms", () => {
  it("measures the int16-scale RMS of a chunk", () => {
    expect(pcm16Rms(tone(100, SPEECH).data)).toBeCloseTo(SPEECH, 0);
    expect(pcm16Rms(new Uint8Array(0))).toBe(0);
  });
});

describe("TwilioSpeechGate", () => {
  it("drops continuous line noise so the drain sees an arrival gap", () => {
    const gate = new TwilioSpeechGate();
    for (let i = 0; i < 50; i++) {
      expect(gate.admit(tone(100, NOISE))).toEqual([]);
    }
    expect(gate.isSpeaking).toBe(false);
    expect(gate.droppedChunks).toBe(50);
    expect(gate.droppedMs).toBeCloseTo(5000, 0);
  });

  it("admits speech, replays the pre-roll at onset, and keeps the hangover", () => {
    const gate = new TwilioSpeechGate({ hangoverMs: 400, prerollMs: 200 });
    // 1 s of silence before the callee speaks: only the last 200 ms is held.
    for (let i = 0; i < 10; i++) gate.admit(tone(100, NOISE));
    const onset = gate.admit(tone(100, SPEECH));
    expect(onset).toHaveLength(3); // 2 × 100 ms pre-roll + the speech chunk
    expect(gate.isSpeaking).toBe(true);
    expect(gate.onsets).toBe(1);
    // The replayed pre-roll is no longer counted as dropped.
    expect(gate.droppedChunks).toBe(8);

    // Mid-sentence pause shorter than the hangover: still admitted.
    expect(gate.admit(tone(100, NOISE))).toHaveLength(1);
    expect(gate.admit(tone(100, NOISE))).toHaveLength(1);
    expect(gate.admit(tone(100, SPEECH))).toHaveLength(1);
    expect(gate.isSpeaking).toBe(true);

    // Callee stops: 400 ms of hangover is admitted, then nothing.
    for (let i = 0; i < 4; i++) expect(gate.admit(tone(100, NOISE))).toHaveLength(1);
    expect(gate.admit(tone(100, NOISE))).toEqual([]);
    expect(gate.isSpeaking).toBe(false);
  });

  it("uses the default threshold when none is given", () => {
    const gate = new TwilioSpeechGate();
    expect(gate.admit(tone(100, DEFAULT_SPEECH_GATE_RMS_THRESHOLD - 1))).toEqual([]);
    expect(gate.admit(tone(100, DEFAULT_SPEECH_GATE_RMS_THRESHOLD + 1))).not.toEqual([]);
  });

  it("passes the empty terminal sentinel through and resets", () => {
    const gate = new TwilioSpeechGate();
    gate.admit(tone(100, SPEECH));
    const sentinel = new AudioChunk({ data: new Uint8Array(0) });
    expect(gate.admit(sentinel)).toEqual([sentinel]);
    expect(gate.isSpeaking).toBe(false);
  });

  it("reset() forgets held pre-roll so a new call does not replay old silence", () => {
    const gate = new TwilioSpeechGate({ prerollMs: 500 });
    for (let i = 0; i < 5; i++) gate.admit(tone(100, NOISE));
    gate.reset();
    expect(gate.admit(tone(100, SPEECH))).toHaveLength(1);
  });

  it("resetCounters() zeroes the lifetime counters but reset() keeps them", () => {
    const gate = new TwilioSpeechGate();
    for (let i = 0; i < 5; i++) gate.admit(tone(100, NOISE));
    gate.admit(tone(100, SPEECH));
    gate.reset();
    expect(gate.onsets).toBe(1);
    expect(gate.droppedChunks).toBeGreaterThan(0);
    gate.resetCounters();
    expect(gate.onsets).toBe(0);
    expect(gate.droppedChunks).toBe(0);
    expect(gate.droppedMs).toBe(0);
  });
});
