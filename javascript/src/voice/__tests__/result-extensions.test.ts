/**
 * ScenarioResult voice-extension bindings — PR5 of issue #372.
 *
 * Binds 6 scenarios from `specs/voice-agents.feature` tagged
 * `@ts-result-ext`: the back-compat scenario (text-only result is
 * unchanged) plus the voice-only `audio`/`timeline`/`latency` extensions.
 */

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

import type { ScenarioResult } from "../../domain";
import {
  computeLatencyMetrics,
  VoiceRecordingRuntime,
} from "../recording.runtime";
import type {
  AudioSegment,
  LatencyMetrics,
  VoiceEvent,
} from "../recording.types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");
const SAMPLE_RATE = 24000;

function pcmSegment(
  speaker: "user" | "agent",
  startTime: number,
  endTime: number,
  transcript?: string,
): AudioSegment {
  const numSamples = Math.floor((endTime - startTime) * SAMPLE_RATE);
  const data = new Uint8Array(numSamples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 80) % 30000) - 15000, true);
  }
  return { speaker, startTime, endTime, audio: data, transcript };
}

function makeTextResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    runId: "test-run",
    success: true,
    messages: [],
    metCriteria: [],
    unmetCriteria: [],
    totalTime: 1.5,
    agentTime: 0.8,
    reasoning: "all criteria met",
    ...overrides,
  };
}

function makeVoiceResult(overrides: {
  segments?: AudioSegment[];
  timeline?: VoiceEvent[];
  latency?: LatencyMetrics;
} = {}): ScenarioResult {
  const recording = new VoiceRecordingRuntime({
    segments: overrides.segments ?? [
      pcmSegment("user", 0.0, 0.1, "hi"),
      pcmSegment("agent", 0.1, 0.3, "hello"),
    ],
    timeline: overrides.timeline,
  });
  return {
    ...makeTextResult(),
    audio: recording,
    timeline: recording.timeline,
    latency: overrides.latency,
  };
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -------------------------------------------------- back-compat (text-only)
    Scenario(
      "ScenarioResult preserves existing fields",
      ({ Given, Then }) => {
        let result: ScenarioResult;

        Given("a voice scenario completes", () => {
          result = makeTextResult();
        });

        Then(
          "result has: success, passed_criteria, failed_criteria, reasoning, messages, total_time, agent_time",
          () => {
            // Pyramid-level back-compat check — the text-only result keeps
            // every PR0 field. PR5 only ADDS optional voice fields.
            expect(typeof result.success).toBe("boolean");
            expect(Array.isArray(result.metCriteria)).toBe(true);
            expect(Array.isArray(result.unmetCriteria)).toBe(true);
            expect(typeof result.reasoning).toBe("string");
            expect(Array.isArray(result.messages)).toBe(true);
            expect(typeof result.totalTime).toBe("number");
            expect(typeof result.agentTime).toBe("number");
            // Voice fields stay undefined for text-only runs.
            expect(result.audio).toBeUndefined();
            expect(result.timeline).toBeUndefined();
            expect(result.latency).toBeUndefined();
          },
        );
      },
    );

    // ---------------------------------------------------- result.audio.save WAV
    Scenario(
      "result.audio.save() writes a WAV file of the full conversation",
      ({ Given, When, Then }) => {
        let result: ScenarioResult;
        let outPath: string;

        Given("a voice scenario result", () => {
          result = makeVoiceResult();
        });

        When('result.audio.save("out.wav") is called', () => {
          const dir = mkdtempSync(join(tmpdir(), "ts-result-wav-"));
          outPath = join(dir, "out.wav");
          (result.audio as VoiceRecordingRuntime).save(outPath);
        });

        Then("a WAV file containing both speakers' audio is written", () => {
          const bytes = readFileSync(outPath);
          expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
          expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
          // Both segments are concatenated in the data chunk.
          const dataSize = bytes.readUInt32LE(40);
          // 0.3s of 16-bit mono @ 24kHz ≈ 14400 bytes — should be > a single segment.
          expect(dataSize).toBeGreaterThan(6000);
        });
      },
    );

    // ---------------------------------------------------- result.audio.save MP3
    Scenario(
      'result.audio.save() with format="mp3" writes MP3 via ffmpeg',
      ({ Given, When, Then }) => {
        let result: ScenarioResult;
        let outPath: string;

        Given("a voice scenario result", () => {
          result = makeVoiceResult();
        });

        When('result.audio.save("out.mp3", format="mp3") is called', () => {
          const dir = mkdtempSync(join(tmpdir(), "ts-result-mp3-"));
          outPath = join(dir, "out.mp3");
          (result.audio as VoiceRecordingRuntime).save(outPath, "mp3");
        });

        Then("an MP3 file is written using the bundled ffmpeg binary", () => {
          const size = statSync(outPath).size;
          expect(size).toBeGreaterThan(0);
          const bytes = readFileSync(outPath);
          const isID3 = bytes.subarray(0, 3).toString("ascii") === "ID3";
          if (!isID3) {
            expect(bytes[0]).toBe(0xff);
            expect((bytes[1] & 0xe0) >>> 5).toBe(0b111);
          }
        });
      },
    );

    // ------------------------------------------- result.audio.segments per-role
    Scenario(
      "result.audio.segments expose per-speaker AudioSegment objects",
      ({ Given, Then }) => {
        let result: ScenarioResult;

        Given("a two-turn voice scenario result", () => {
          result = makeVoiceResult();
        });

        Then(
          "each segment has speaker, start_time, end_time, audio (bytes), transcript",
          () => {
            const segments = result.audio?.segments ?? [];
            expect(segments).toHaveLength(2);
            for (const seg of segments) {
              expect(["user", "agent"]).toContain(seg.speaker);
              expect(typeof seg.startTime).toBe("number");
              expect(typeof seg.endTime).toBe("number");
              expect(seg.audio).toBeInstanceOf(Uint8Array);
              expect(seg.audio.length).toBeGreaterThan(0);
              expect(typeof seg.transcript).toBe("string");
            }
          },
        );
      },
    );

    // ------------------------------------------------------- result.timeline
    Scenario(
      "result.timeline lists VoiceEvent objects in order",
      ({ Given, Then }) => {
        let result: ScenarioResult;

        Given("a voice scenario with interruptions", () => {
          const timeline: VoiceEvent[] = [
            { time: 0.0, type: "user_start_speaking" },
            { time: 0.1, type: "user_stop_speaking" },
            { time: 0.12, type: "agent_start_speaking", latency: 0.02 },
            { time: 1.2, type: "user_interrupt", metadata: { native: true } },
            { time: 1.5, type: "agent_stop_speaking" },
          ];
          result = makeVoiceResult({ timeline });
        });

        Then(
          "timeline contains VoiceEvent entries for user_start_speaking, user_stop_speaking, agent_start_speaking, user_interrupt, agent_stop_speaking in time order",
          () => {
            const types = (result.timeline ?? []).map((e) => e.type);
            expect(types).toEqual([
              "user_start_speaking",
              "user_stop_speaking",
              "agent_start_speaking",
              "user_interrupt",
              "agent_stop_speaking",
            ]);
            // Times are monotonically non-decreasing.
            const times = (result.timeline ?? []).map((e) => e.time);
            for (let i = 1; i < times.length; i++) {
              expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
            }
          },
        );
      },
    );

    // -------------------------------------------------------- result.latency
    Scenario(
      "result.latency exposes response-time statistics",
      ({ Given, Then }) => {
        let result: ScenarioResult;

        Given("a voice scenario with multiple agent responses", () => {
          const latency = computeLatencyMetrics({
            measurements: [0.1, 0.2, 0.3, 0.4, 0.5],
            timeToFirstByte: 0.08,
            interruptResponseTime: 0.21,
          });
          result = makeVoiceResult({ latency });
        });

        Then(
          "latency has avg_response_time, p50_response_time, p95_response_time, time_to_first_byte, interrupt_response_time, measurements",
          () => {
            const l = result.latency;
            expect(l).toBeDefined();
            expect(l!.avgResponseTime).toBeCloseTo(0.3, 5);
            expect(l!.p50ResponseTime).toBeCloseTo(0.3, 5);
            expect(l!.p95ResponseTime).toBeCloseTo(0.5, 5);
            expect(l!.timeToFirstByte).toBeCloseTo(0.08, 5);
            expect(l!.interruptResponseTime).toBeCloseTo(0.21, 5);
            expect(l!.measurements.length).toBe(5);
          },
        );
      },
    );
  },
  { includeTags: [["ts-result-ext"]] },
);
