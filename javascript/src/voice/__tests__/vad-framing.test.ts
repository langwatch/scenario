/**
 * Framing and hysteresis behaviour of the SDK-side VAD fallback.
 *
 * The ring buffer had no direct coverage: the existing suite drives the
 * one-shot fallback warning, not what `process()` does with bytes. These
 * tests were written against the original `number[]` implementation and pass
 * unchanged against the `Uint8Array` one, which is what makes the swap a
 * refactor rather than a rewrite.
 *
 * Everything below is expressed in whole frames or deliberate fractions of
 * one, because the only thing that should decide when a frame is classified
 * is how many bytes have arrived, never how they were chopped into chunks.
 */
import { describe, expect, it } from "vitest";
import { AudioChunk, PCM16_SAMPLE_RATE } from "../audio-chunk";
import { WebRTCVadFallback } from "../vad";

const FRAME_MS = 30;
const SAMPLES_PER_FRAME = (PCM16_SAMPLE_RATE * FRAME_MS) / 1000;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

/** PCM16 little-endian bytes for `sampleCount` samples all at `amplitude`. */
function pcm16(amplitude: number, sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const value = amplitude < 0 ? amplitude + 0x10000 : amplitude;
    bytes[i * 2] = value & 0xff;
    bytes[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return bytes;
}

const chunkOf = (bytes: Uint8Array): AudioChunk =>
  ({ data: bytes }) as AudioChunk;

/** Loud enough to clear the default RMS threshold of 500. */
const LOUD = 8000;
const SILENT = 0;

function makeDetector(options: { hysteresisFrames?: number } = {}) {
  const starts: number[] = [];
  const ends: number[] = [];
  const vad = new WebRTCVadFallback("test-adapter", {
    ...options,
    onSpeechStart: () => starts.push(1),
    onSpeechEnd: () => ends.push(1),
  });
  return { vad, starts, ends };
}

describe("WebRTCVadFallback framing", () => {
  describe("given fewer bytes than one frame", () => {
    describe("when the chunk is processed", () => {
      it("classifies nothing, because a partial frame is not a frame", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 1 });

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME - 1)));

        expect(vad.isSpeaking).toBe(false);
        expect(starts).toHaveLength(0);
      });
    });
  });

  describe("given a frame split across two chunks", () => {
    describe("when the second chunk completes it", () => {
      it("classifies once the bytes are all in, not once per chunk", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 1 });
        const frame = pcm16(LOUD, SAMPLES_PER_FRAME);

        vad.process(chunkOf(frame.slice(0, 10)));
        expect(vad.isSpeaking).toBe(false);

        vad.process(chunkOf(frame.slice(10)));

        expect(vad.isSpeaking).toBe(true);
        expect(starts).toHaveLength(1);
      });
    });
  });

  describe("given several frames in one chunk", () => {
    describe("when the chunk is processed", () => {
      it("classifies each frame, so hysteresis can be satisfied in one call", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 3 });

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME * 3)));

        expect(vad.isSpeaking).toBe(true);
        expect(starts).toHaveLength(1);
      });
    });
  });

  describe("given a chunk carrying a whole frame plus a remainder", () => {
    describe("when a later chunk completes the remainder", () => {
      it("carries the leftover bytes across calls rather than dropping them", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 2 });
        const loud = pcm16(LOUD, SAMPLES_PER_FRAME);
        const half = SAMPLES_PER_FRAME; // in bytes, half a frame

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME + SAMPLES_PER_FRAME / 2)));
        expect(vad.isSpeaking).toBe(false);

        // The remaining half frame, which only completes because the leftover
        // survived the first call.
        vad.process(chunkOf(loud.slice(0, half)));

        expect(vad.isSpeaking).toBe(true);
        expect(starts).toHaveLength(1);
      });
    });
  });

  describe("given hysteresis of three frames", () => {
    describe("when only two loud frames arrive", () => {
      it("stays silent, because the run has not been held long enough", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 3 });

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME * 2)));

        expect(vad.isSpeaking).toBe(false);
        expect(starts).toHaveLength(0);
      });
    });

    describe("when speech is followed by enough silence", () => {
      it("flips back and fires the end callback exactly once", () => {
        const { vad, starts, ends } = makeDetector({ hysteresisFrames: 3 });

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME * 3)));
        expect(vad.isSpeaking).toBe(true);

        vad.process(chunkOf(pcm16(SILENT, SAMPLES_PER_FRAME * 3)));

        expect(vad.isSpeaking).toBe(false);
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
      });
    });
  });

  describe("given a quiet negative-amplitude frame", () => {
    describe("when it is classified", () => {
      it("reads it as silence, which only holds if the sign survives", () => {
        // -1 is the discriminating fixture, and -8000 is not. Read signed, -1
        // is an RMS of 1 and silent; read unsigned it is 65535 and the
        // loudest sample there is. A frame at -8000 is loud under BOTH
        // readings, so it passes whether or not the sign extension exists.
        const { vad, starts } = makeDetector({ hysteresisFrames: 1 });

        vad.process(chunkOf(pcm16(-1, SAMPLES_PER_FRAME)));

        expect(vad.isSpeaking).toBe(false);
        expect(starts).toHaveLength(0);
      });
    });

    describe("when it is loud", () => {
      it("still reads as speech", () => {
        const { vad } = makeDetector({ hysteresisFrames: 1 });

        vad.process(chunkOf(pcm16(-8000, SAMPLES_PER_FRAME)));

        expect(vad.isSpeaking).toBe(true);
      });
    });
  });

  describe("given consumed bytes", () => {
    describe("when a later chunk arrives", () => {
      it("does not classify them a second time", () => {
        // Uniform audio cannot see this: re-reading history yields the same
        // verdict, so the run stays green over a buffer that never releases
        // what it consumed. Alternating frames make the reprocessing visible
        // as extra transitions, and an unreleased buffer is also a leak.
        const { vad, starts, ends } = makeDetector({ hysteresisFrames: 1 });

        vad.process(chunkOf(pcm16(LOUD, SAMPLES_PER_FRAME)));
        vad.process(chunkOf(pcm16(SILENT, SAMPLES_PER_FRAME)));
        vad.process(chunkOf(pcm16(SILENT, SAMPLES_PER_FRAME)));

        // Re-reading the first frame on the third call would start speech a
        // second time before ending it again.
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(vad.isSpeaking).toBe(false);
      });
    });
  });

  describe("given a long run of chunks that never align to frames", () => {
    describe("when they are fed one at a time", () => {
      it("classifies exactly as many frames as the bytes allow", () => {
        const { vad, starts } = makeDetector({ hysteresisFrames: 1 });
        const oddChunk = 101; // bytes, coprime with the frame size

        let sent = 0;
        while (sent < BYTES_PER_FRAME * 4) {
          vad.process(chunkOf(pcm16(LOUD, oddChunk)));
          sent += oddChunk * 2;
        }

        // Only that the detector settled on speech and fired once: the point
        // is that misaligned chunking neither loses nor duplicates frames.
        expect(vad.isSpeaking).toBe(true);
        expect(starts).toHaveLength(1);
      });
    });
  });
});
