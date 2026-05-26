/**
 * transcribeSegments tests (issue #372 voice port).
 *
 * Binds `specs/voice-agents.feature` scenarios tagged `@ts-transcribe`:
 *   - transcribe_segments fills missing transcripts in place
 *   - missing STT provider degrades gracefully
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

import type { AudioChunk } from "../audio-chunk";
import { type STTProvider } from "../stt";
import { transcribeSegments } from "../transcribe";
import type { AudioSegment, VoiceRecording } from "../recording.types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");

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

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: transcribe_segments fills missing transcripts in place
    // -----------------------------------------------------------------------
    Scenario(
      "transcribe_segments fills missing transcripts in place",
      ({ Given, When, Then, And }) => {
        let recording: VoiceRecording;
        let spy: ReturnType<typeof vi.fn>;

        Given("a VoiceRecording with two agent segments lacking transcripts", () => {
          spy = vi.fn(async (_audio: AudioChunk): Promise<string> => "filled");
          recording = makeRecording([
            { speaker: "agent" },
            { speaker: "agent" },
            { speaker: "user", transcript: "already-here" },
          ]);
          expect(recording.segments[0].transcript).toBeUndefined();
          expect(recording.segments[1].transcript).toBeUndefined();
          expect(recording.segments[2].transcript).toBe("already-here");
        });

        When("transcribe_segments is called with a configured STT provider", async () => {
          await transcribeSegments(recording, {
            provider: { transcribe: spy as unknown as STTProvider["transcribe"] },
          });
        });

        Then("both segments have non-null transcript", async () => {
          expect(recording.segments[0].transcript).toBe("filled");
          expect(recording.segments[1].transcript).toBe("filled");

          // Verify in-place mutation: the original segment reference sees the transcript.
          const singleRecording = makeRecording([{ speaker: "agent" }]);
          const segmentRef = singleRecording.segments[0];
          expect(segmentRef.transcript).toBeUndefined();
          await transcribeSegments(singleRecording, {
            provider: {
              transcribe: async () => "in-place",
            },
          });
          expect(segmentRef.transcript).toBe("in-place");
          expect(singleRecording.segments[0]).toBe(segmentRef);
        });

        And("segments that already had a transcript are not re-transcribed", () => {
          expect(recording.segments[2].transcript).toBe("already-here");
          // Provider invoked twice — once per missing agent segment, not for
          // the user segment that already had a transcript.
          expect(spy).toHaveBeenCalledTimes(2);
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: missing STT provider degrades gracefully
    // -----------------------------------------------------------------------
    Scenario(
      "missing STT provider degrades gracefully",
      ({ Given, Then, And }) => {
        let warnings: string[];
        let recording: VoiceRecording;

        Given("transcribe_segments is called with no configured STT provider", async () => {
          warnings = [];
          recording = makeRecording([{ speaker: "agent" }, { speaker: "user" }]);

          // No global provider exists anymore (ADR-002): "no provider" is
          // expressed by passing `provider: null` explicitly.
          await expect(
            transcribeSegments(recording, {
              provider: null,
              logWarn: (m) => warnings.push(m),
            }),
          ).resolves.toBeUndefined();
        });

        Then("it logs a warning and returns without raising", () => {
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatch(/no STT provider configured/);
          expect(warnings[0]).toMatch(/run\(\{ voice/);
        });

        And("segment transcripts remain null", async () => {
          expect(recording.segments[0].transcript).toBeUndefined();
          expect(recording.segments[1].transcript).toBeUndefined();

          // Per-segment STT failures are also caught and logged without raising.
          const failing: STTProvider = {
            transcribe: async () => {
              throw new Error("upstream went down");
            },
          };
          const failWarnings: string[] = [];
          const failRecording = makeRecording([{ speaker: "agent" }]);

          await expect(
            transcribeSegments(failRecording, {
              provider: failing,
              logWarn: (m) => failWarnings.push(m),
            }),
          ).resolves.toBeUndefined();

          expect(failWarnings.some((w) => w.includes("STT failed"))).toBe(true);
          expect(failRecording.segments[0].transcript).toBeUndefined();

          // Empty recording returns immediately without calling provider.
          const emptyProvider: STTProvider = { transcribe: vi.fn() };
          const emptyRecording: VoiceRecording = { segments: [], timeline: [] };
          await transcribeSegments(emptyRecording, { provider: emptyProvider });
          expect(emptyProvider.transcribe).not.toHaveBeenCalled();

          // Segments with empty audio are skipped.
          const skipSpy = vi.fn().mockResolvedValue("x");
          const skipProvider: STTProvider = { transcribe: skipSpy };
          const skipRecording = makeRecording([
            { speaker: "agent", audio: new Uint8Array(0) },
            { speaker: "user", audio: PCM_BYTES },
          ]);
          await transcribeSegments(skipRecording, { provider: skipProvider });
          expect(skipSpy).toHaveBeenCalledTimes(1);
          expect(skipRecording.segments[0].transcript).toBeUndefined();
          expect(skipRecording.segments[1].transcript).toBe("x");
        });
      },
    );
  },
  { includeTags: ["ts-transcribe"] },
);
