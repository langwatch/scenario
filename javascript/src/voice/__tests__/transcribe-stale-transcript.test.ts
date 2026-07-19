/**
 * Regression guard for the audio-derived STT assertion (#725).
 *
 * The voice example tests prove a turn is "audio-derived" by force-running STT
 * over the recorded user bytes (`transcribeSegments(..., { onlyMissing: false })`)
 * and then asserting every user segment has a non-empty `transcript`. But
 * `transcribeSegments` catches a provider throw and leaves `transcript`
 * untouched (documented graceful-degrade). So if a segment already carries a
 * transcript from the live run and STT then suffers a transient outage (the
 * provider throws), the stale transcript survives and the assertion greens
 * dishonestly. The fix is to clear the transcripts before the forced re-run.
 *
 * These tests exercise the real `transcribeSegments` path with a throwing
 * provider to lock both facts: the stale transcript survives an outage, and
 * clearing it first makes the outage observable.
 */
import { describe, expect, it } from "vitest";

import { type STTProvider } from "../stt";
import { transcribeSegments } from "../transcribe";
import type { AudioSegment, VoiceRecording } from "../recording.types";

const PCM_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function userSegment(transcript?: string): AudioSegment {
  return {
    speaker: "user",
    startTime: 0,
    endTime: 1,
    audio: PCM_BYTES,
    transcript,
  };
}

/** STT provider that always throws, standing in for a transient outage. */
const outageProvider: STTProvider = {
  transcribe: async () => {
    throw new Error("stt upstream timed out");
  },
};

describe("transcribeSegments under a transient STT outage (#725)", () => {
  describe("given a user segment that already carries a live-run transcript", () => {
    describe("when a forced re-run hits an STT outage", () => {
      it("leaves the stale transcript in place, so a non-empty check greens dishonestly", async () => {
        const recording: VoiceRecording = {
          segments: [userSegment("stale live-run text")],
          timeline: [],
        };

        await transcribeSegments(recording, {
          provider: outageProvider,
          onlyMissing: false,
          logWarn: () => {},
        });

        // The outage was swallowed and the old transcript survived: the
        // "(transcript ?? '').trim().length > 0" bar the example tests use
        // would still pass. This is exactly the hole #725 closes.
        expect(recording.segments[0]!.transcript).toBe("stale live-run text");
        expect((recording.segments[0]!.transcript ?? "").trim().length).toBeGreaterThan(0);
      });
    });
  });

  describe("given the transcript is cleared before the forced re-run", () => {
    describe("when the re-run hits an STT outage", () => {
      it("leaves the transcript empty, so the non-empty check fails honestly", async () => {
        const recording: VoiceRecording = {
          segments: [userSegment("stale live-run text")],
          timeline: [],
        };

        // The fix applied by the example tests before the forced re-run.
        for (const s of recording.segments) s.transcript = undefined;

        await transcribeSegments(recording, {
          provider: outageProvider,
          onlyMissing: false,
          logWarn: () => {},
        });

        expect(recording.segments[0]!.transcript).toBeUndefined();
        expect((recording.segments[0]!.transcript ?? "").trim().length).toBe(0);
      });
    });

    describe("when the re-run reaches a healthy provider", () => {
      it("fills the audio-derived transcript, so the happy path still passes", async () => {
        const recording: VoiceRecording = {
          segments: [userSegment("stale live-run text")],
          timeline: [],
        };
        const healthy: STTProvider = { transcribe: async () => "audio derived text" };

        for (const s of recording.segments) s.transcript = undefined;

        await transcribeSegments(recording, {
          provider: healthy,
          onlyMissing: false,
          logWarn: () => {},
        });

        expect(recording.segments[0]!.transcript).toBe("audio derived text");
        expect((recording.segments[0]!.transcript ?? "").trim().length).toBeGreaterThan(0);
      });
    });
  });
});
