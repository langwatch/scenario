/**
 * transcribeSegments tests — PR2 of issue #372.
 *
 * Binds `specs/voice-agents.feature`:
 *   - lines 857-865: transcribe_segments fills missing transcripts in place.
 *   - lines 872-878: missing STT provider degrades gracefully.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AudioChunk } from "../audio-chunk";
import { OpenAISTTProvider, setSttProvider, type STTProvider } from "../stt";
import { transcribeSegments } from "../transcribe";
import type { AudioSegment, VoiceRecording } from "../recording.types";

const PCM_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function makeRecording(
  segments: Array<Partial<AudioSegment> & Pick<AudioSegment, "speaker">>,
): VoiceRecording {
  return {
    segments: segments.map((s, i) => ({
      speaker: s.speaker,
      startTime: s.startTime ?? i,
      endTime: s.endTime ?? i + 1,
      audio: s.audio ?? PCM_BYTES,
      transcript: s.transcript,
      transcriptTruncated: s.transcriptTruncated,
    })),
    timeline: [],
  };
}

describe("specs/voice-agents.feature lines 857-865 — transcribe_segments fills missing transcripts in place", () => {
  afterEach(() => {
    setSttProvider(new OpenAISTTProvider());
  });

  it("fills .transcript on both segments and skips ones that already have a transcript", async () => {
    const spy = vi.fn(async (_audio: AudioChunk): Promise<string> => "filled");
    const recording = makeRecording([
      { speaker: "agent" },
      { speaker: "agent" },
      { speaker: "user", transcript: "already-here" },
    ]);

    await transcribeSegments(recording, { provider: { transcribe: spy } });

    expect(recording.segments[0].transcript).toBe("filled");
    expect(recording.segments[1].transcript).toBe("filled");
    expect(recording.segments[2].transcript).toBe("already-here");
    // Provider should be invoked twice — once per agent segment, not for
    // the user segment that already had a transcript (idempotent).
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("mutates segments in place — the original recording reference now sees the transcripts", async () => {
    const recording = makeRecording([{ speaker: "agent" }]);
    const segmentRef = recording.segments[0];
    expect(segmentRef.transcript).toBeUndefined();

    const provider: STTProvider = {
      transcribe: async () => "in-place",
    };
    await transcribeSegments(recording, { provider });

    expect(segmentRef.transcript).toBe("in-place"); // same reference, mutated
    expect(recording.segments[0]).toBe(segmentRef);
  });

  it("returns immediately when the recording has no segments", async () => {
    const provider: STTProvider = { transcribe: vi.fn() };
    const recording: VoiceRecording = { segments: [], timeline: [] };
    await transcribeSegments(recording, { provider });
    expect(provider.transcribe).not.toHaveBeenCalled();
  });

  it("skips segments with empty audio", async () => {
    const spy = vi.fn().mockResolvedValue("x");
    const provider: STTProvider = { transcribe: spy };
    const recording = makeRecording([
      { speaker: "agent", audio: new Uint8Array(0) },
      { speaker: "user", audio: PCM_BYTES },
    ]);
    await transcribeSegments(recording, { provider });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(recording.segments[0].transcript).toBeUndefined();
    expect(recording.segments[1].transcript).toBe("x");
  });
});

describe("specs/voice-agents.feature lines 872-878 — missing STT provider degrades gracefully", () => {
  afterEach(() => {
    setSttProvider(new OpenAISTTProvider());
  });

  it("logs a warning and returns without raising when no provider is configured", async () => {
    setSttProvider(null);
    const warnings: string[] = [];
    const recording = makeRecording([{ speaker: "agent" }, { speaker: "user" }]);

    await expect(
      transcribeSegments(recording, {
        logWarn: (m) => warnings.push(m),
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no STT provider configured/);
    expect(warnings[0]).toMatch(/scenario\.configure/);

    // Segment transcripts must remain undefined — graceful degradation, not
    // a partial-fill that silently masks the missing provider.
    expect(recording.segments[0].transcript).toBeUndefined();
    expect(recording.segments[1].transcript).toBeUndefined();
  });

  it("per-segment STT failures are caught, logged, and leave transcript undefined", async () => {
    const failing: STTProvider = {
      transcribe: async () => {
        throw new Error("upstream went down");
      },
    };
    const warnings: string[] = [];
    const recording = makeRecording([{ speaker: "agent" }]);

    await expect(
      transcribeSegments(recording, {
        provider: failing,
        logWarn: (m) => warnings.push(m),
      }),
    ).resolves.toBeUndefined();

    expect(warnings.some((w) => w.includes("STT failed"))).toBe(true);
    expect(recording.segments[0].transcript).toBeUndefined();
  });
});
