/**
 * Executor audio-result integration test — Gaps A & B of issue #372 Tier C.
 *
 * Gap A: `ScenarioExecution.setResult()` attaches `audio` / `timeline` /
 *        `latency` to the `ScenarioResult` for voice runs.
 * Gap B: the per-run recording the executor builds is a
 *        {@link VoiceRecordingRuntime} instance (not a bare object), so
 *        `result.audio.save()` / `result.audio.saveSegments()` exist.
 *
 * This is an OFFLINE / fake-transport test — it drives a real
 * `ScenarioExecution.execute()` (the same path `scenario.run()` takes) with a
 * voice {@link FakeVoiceAdapter} (AGENT role), an audio-producing user
 * simulator, and a fake judge. No network, no real keys. The real-key e2e is
 * the NEXT stage.
 *
 * Coverage:
 *   - `result.audio instanceof VoiceRecordingRuntime`
 *   - `result.audio.segments.length > 0` (user + agent segments recorded)
 *   - `result.timeline` populated with speaking events
 *   - `result.latency` populated (measurements from the agent response turn)
 *   - `result.audio.save(...)` round-trips a WAV to disk (proves Gap B —
 *     the runtime method is callable off `result.audio`).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, judge, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { AudioChunk } from "../audio-chunk";
import { createAudioMessage } from "../messages";
import { VoiceRecordingRuntime } from "../recording.runtime";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";
import { PassingJudge } from "./fixtures/passing-judge";

/** A short non-silent PCM16 chunk (mono, 24kHz) carrying a transcript. */
function tone(durationSeconds: number, transcript: string): AudioChunk {
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data, transcript });
}

/**
 * User simulator that emits an AUDIO message (not text) so the voice agent's
 * default `call()` extracts incoming user audio and records a user segment.
 */
class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(
      tone(0.12, "I need help with my account"),
      "user",
    ) as unknown as AgentReturnTypes;
  }
}


function buildVoiceExecution(): {
  execution: ScenarioExecution;
  adapter: FakeVoiceAdapter;
} {
  // The FakeVoiceAdapter (AGENT) yields one agent audio chunk via
  // receiveAudio, then a silent end-of-stream chunk so the drain loop exits.
  const adapter = new FakeVoiceAdapter({
    responses: [tone(0.2, "Sure, happy to help with that.")],
  });
  const execution = new ScenarioExecution(
    {
      name: "voice / result audio attach",
      description: "Gaps A & B — result.audio/timeline/latency populated",
      agents: [adapter, new AudioUserSimulator(), new PassingJudge()],
    },
    [user(), agent(), judge()],
    "test-batch-id",
  );
  return { execution, adapter };
}

describe("ScenarioResult voice fields are attached by the executor (Gaps A & B)", () => {
  it("result.audio is a VoiceRecordingRuntime with recorded segments", async () => {
    const { execution } = buildVoiceExecution();
    const result = await execution.execute();

    expect(result.success).toBe(true);
    // Gap B — the attached recording is the runtime class, not a bare object,
    // so save()/saveSegments() exist on result.audio.
    expect(result.audio).toBeInstanceOf(VoiceRecordingRuntime);
    expect(typeof (result.audio as VoiceRecordingRuntime).save).toBe(
      "function",
    );
    expect(
      typeof (result.audio as VoiceRecordingRuntime).saveSegments,
    ).toBe("function");

    // Gap A — segments recorded (one user audio turn + one agent response).
    const segments = result.audio!.segments;
    expect(segments.length).toBeGreaterThan(0);
    const speakers = new Set(segments.map((s) => s.speaker));
    expect(speakers.has("user")).toBe(true);
    expect(speakers.has("agent")).toBe(true);
  });

  it("result.timeline is populated with speaking events in time order", async () => {
    const { execution } = buildVoiceExecution();
    const result = await execution.execute();

    const timeline = result.timeline ?? [];
    expect(timeline.length).toBeGreaterThan(0);
    const types = timeline.map((e) => e.type);
    expect(types).toContain("user_start_speaking");
    expect(types).toContain("agent_start_speaking");

    // result.timeline aliases result.audio.timeline (the runtime appends to
    // both during the run) — they must be the same content.
    expect(result.audio!.timeline.length).toBe(timeline.length);

    // Times are monotonically non-decreasing.
    const times = timeline.map((e) => e.time);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it("result.latency is populated with response-time measurements", async () => {
    const { execution } = buildVoiceExecution();
    const result = await execution.execute();

    const latency = result.latency;
    expect(latency).toBeDefined();
    expect(Array.isArray(latency!.measurements)).toBe(true);
    // The agent responds after the user audio is sent (serial wire model),
    // so at least one non-negative response-time measurement is recorded and
    // the aggregate avg/p50/p95 are derived.
    expect(latency!.measurements.length).toBeGreaterThan(0);
    expect(latency!.avgResponseTime).toBeDefined();
    expect(latency!.p50ResponseTime).toBeDefined();
    expect(latency!.p95ResponseTime).toBeDefined();
    expect(latency!.timeToFirstByte).toBeDefined();
  });

  it("result.audio.save() round-trips a WAV to disk (Gap B method is callable)", async () => {
    const { execution } = buildVoiceExecution();
    const result = await execution.execute();

    const dir = mkdtempSync(join(tmpdir(), "ts-result-audio-"));
    const outPath = join(dir, "conversation.wav");
    const written = (result.audio as VoiceRecordingRuntime).save(outPath);
    expect(written).toBe(outPath);

    const bytes = readFileSync(outPath);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // Both segments concatenated → a non-trivial data chunk.
    expect(bytes.readUInt32LE(40)).toBeGreaterThan(0);
  });

  it("text-only runs do not attach voice fields (back-compat)", async () => {
    // No voice adapter → setResult leaves audio/timeline/latency undefined.
    class TextAgent extends UserSimulatorAgentAdapter {
      role = AgentRole.AGENT;
      async call(_input: AgentInput): Promise<AgentReturnTypes> {
        return { role: "assistant" as const, content: "hello" };
      }
    }
    const execution = new ScenarioExecution(
      {
        name: "text-only / no voice fields",
        description: "back-compat — voice fields stay undefined",
        agents: [new TextAgent(), new PassingJudge()],
      },
      [agent(), judge()],
      "test-batch-id",
    );
    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(result.audio).toBeUndefined();
    expect(result.timeline).toBeUndefined();
    expect(result.latency).toBeUndefined();
  });
});
