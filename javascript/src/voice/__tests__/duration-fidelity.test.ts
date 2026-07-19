/**
 * M1 REGRESSION GUARD — recording duration is byte-accurate, not wall-clock.
 *
 * The /review M1 finding: segment durations + `manifest.duration` were
 * timestamped at the wall-clock instant `sendAudio` / `receiveAudio` resolved.
 * On in-process / fast transports (composable, realtime) a multi-second turn
 * collapses to ~1 ms, so `manifest.duration` (and the LatencyMetrics derived
 * from it) became unreliable as proof of audio length even though the PCM
 * bytes were real and correct. Evidence at the time: `voice_text_parity` user
 * segment 0.001 s vs `full.wav` 5.65 s.
 *
 * This guard drives the REAL production recording path — a `ScenarioExecution`
 * with a voice {@link FakeVoiceAdapter} (the same path `scenario.run()` takes,
 * delegating to `defaultVoiceCall` in `adapter.runtime.ts`) — then writes the
 * recording to disk via the production `saveSegments` writer and asserts the
 * on-disk manifest's `duration` matches the on-disk `full.wav` byte-duration.
 *
 * It deliberately does NOT use the synthetic `pcmSegment` fixture from
 * `recording.runtime.test.ts` (which builds `data.length` from `endTime -
 * startTime`, FORCING agreement and masking M1). Here the audio bytes come
 * from real `AudioChunk`s flowing through the executor, and the timestamps
 * come from the runtime under test — so a wall-clock regression would make
 * `manifest.duration` diverge from the byte-duration and FAIL this test.
 */

import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
import { AudioChunk, PCM16_SAMPLE_RATE, PCM16_SAMPLE_WIDTH_BYTES } from "../audio-chunk";
import { createAudioMessage } from "../messages";
import { VoiceRecordingRuntime } from "../recording.runtime";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";
import { PassingJudge } from "./fixtures/passing-judge";

/** WAV header is 44 bytes; the PCM payload follows. */
const WAV_HEADER_BYTES = 44;

/** Byte-duration (seconds) of a PCM16/24k/mono WAV file on disk. */
function wavByteDuration(path: string): number {
  const pcmBytes = statSync(path).size - WAV_HEADER_BYTES;
  return pcmBytes / PCM16_SAMPLE_WIDTH_BYTES / PCM16_SAMPLE_RATE;
}

/** A non-silent PCM16 chunk (mono, 24kHz) of an EXACT byte-duration. */
function tone(durationSeconds: number, transcript?: string): AudioChunk {
  const numSamples = Math.round(durationSeconds * PCM16_SAMPLE_RATE);
  const data = new Uint8Array(numSamples * PCM16_SAMPLE_WIDTH_BYTES);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data, transcript });
}

/**
 * User simulator that emits a SHORT audio turn. The shortness is the point:
 * under the old wall-clock model the long agent turn that follows still
 * timestamped to a near-instant offset, so `duration` under-reported the
 * audio. With the byte-accurate cursor, `duration` = user + agent byte length.
 */
class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(
      tone(0.5, "I need help with my account"),
      "user",
    ) as unknown as AgentReturnTypes;
  }
}


/**
 * Build a voice run whose agent answers in MULTIPLE chunks so the merged
 * response is several seconds — a turn the old wall-clock model would have
 * collapsed. The fake adapter yields the chunks in order via receiveAudio,
 * then a silent end-of-stream chunk so the drain loop exits.
 */
function buildVoiceExecution(): ScenarioExecution {
  const adapter = new FakeVoiceAdapter({
    responses: [tone(1.5, "Sure"), tone(1.25, " happy to help"), tone(0.75, " with that.")],
  });
  return new ScenarioExecution(
    {
      name: "voice / duration fidelity (M1)",
      description: "manifest.duration must equal full.wav byte-duration",
      agents: [adapter, new AudioUserSimulator(), new PassingJudge()],
    },
    [user(), agent(), judge()],
    "test-batch-id",
  );
}

describe("M1 — recording duration is byte-accurate (manifest.duration ≈ full.wav)", () => {
  it("manifest.duration equals the on-disk full.wav byte-duration", async () => {
    const result = await buildVoiceExecution().execute();
    expect(result.success).toBe(true);
    const recording = result.audio as VoiceRecordingRuntime;
    expect(recording).toBeInstanceOf(VoiceRecordingRuntime);

    const dir = mkdtempSync(join(tmpdir(), "ts-duration-fidelity-"));
    recording.saveSegments(dir, { manifest: true });

    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as { duration: number; segments: Array<{ duration: number; file: string }> };
    const fullWavDur = wavByteDuration(join(dir, "full.wav"));

    // The whole point of M1: the manifest's duration is the AUDIO length, not
    // the wall-clock-of-send. full.wav is the concatenation of every segment's
    // PCM bytes, so its byte-duration is the sum of the segment audio lengths.
    // 1 ms tolerance absorbs float rounding only — a wall-clock regression
    // (which collapses fast in-process turns) would miss by whole seconds.
    expect(Math.abs(manifest.duration - fullWavDur)).toBeLessThan(0.001);

    // And the sanity floor: the merged agent turn alone is ~3.5 s, so the
    // total is comfortably > 3 s. A wall-clock regression would report ~0.
    expect(manifest.duration).toBeGreaterThan(3);
  });

  it("each segment's manifest duration equals its own WAV byte-duration", async () => {
    const result = await buildVoiceExecution().execute();
    const recording = result.audio as VoiceRecordingRuntime;

    const dir = mkdtempSync(join(tmpdir(), "ts-duration-fidelity-seg-"));
    recording.saveSegments(dir, { manifest: true });
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as { segments: Array<{ duration: number; file: string }> };

    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      const segDur = wavByteDuration(join(dir, seg.file));
      // Per-segment byte accuracy: endTime - startTime equals the segment's
      // own PCM byte length, NOT the wall-clock the chunk happened to flush in.
      expect(
        Math.abs(seg.duration - segDur),
        `segment ${seg.file} manifest dur ${seg.duration} != byte dur ${segDur}`,
      ).toBeLessThan(0.001);
    }
  });

  it("segments are laid gapless on the audio cursor (sum of durations = total)", async () => {
    const result = await buildVoiceExecution().execute();
    const recording = result.audio as VoiceRecordingRuntime;

    const sumOfSegments = recording.segments.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    // Gapless end-to-end placement → the total duration is exactly the sum of
    // the per-segment durations (no wall-clock gaps inflate it).
    expect(Math.abs(recording.duration - sumOfSegments)).toBeLessThan(0.001);
  });
});
