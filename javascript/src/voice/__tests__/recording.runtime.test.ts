/**
 * Runtime unit tests for VoiceRecordingRuntime — PR5 of issue #372.
 *
 * Not bound to scenario.run() — these exercise the file writers directly:
 * WAV header correctness, MP3 transcoding (ffmpeg subprocess), segment
 * directory layout, and JSON manifest schema.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFfmpegPath } from "../ffmpeg";

/**
 * Skip ffmpeg-dependent assertions only if the bundled binary is somehow
 * unrunnable. With ffmpeg-static vendored (Python parity) this resolves to a
 * real binary on every CI platform, so these tests run rather than skip.
 */
const HAS_FFMPEG = (() => {
  try {
    return spawnSync(resolveFfmpegPath(), ["-version"]).status === 0;
  } catch {
    return false;
  }
})();
const itIfFfmpeg = HAS_FFMPEG ? it : it.skip;

import {
  computeLatencyMetrics,
  VoiceRecordingRuntime,
} from "../recording.runtime";
import type { AudioSegment, VoiceEvent } from "../recording.types";

const SAMPLE_RATE = 24000;

function pcmSegment(
  speaker: "user" | "agent",
  startTime: number,
  endTime: number,
  transcript?: string,
): AudioSegment {
  const durationSeconds = endTime - startTime;
  const numSamples = Math.floor(durationSeconds * SAMPLE_RATE);
  const data = new Uint8Array(numSamples * 2);
  // Non-silent ramp so transcoders don't elide empty audio.
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 80) % 30000) - 15000, true);
  }
  return { speaker, startTime, endTime, audio: data, transcript };
}

describe("VoiceRecordingRuntime.save", () => {
  it("writes a WAV file with the canonical PCM16/24kHz/mono header", () => {
    const rec = new VoiceRecordingRuntime({
      segments: [
        pcmSegment("user", 0.0, 0.1, "hi"),
        pcmSegment("agent", 0.1, 0.3, "hello"),
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-wav-"));
    const path = join(dir, "out.wav");
    rec.save(path);
    const bytes = readFileSync(path);

    // RIFF / WAVE magic
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(bytes.subarray(36, 40).toString("ascii")).toBe("data");
    // channels, sample rate, bits/sample at canonical positions
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(bytes.readUInt16LE(34)).toBe(16); // 16-bit
  });

  itIfFfmpeg("transcodes to MP3 via the bundled ffmpeg subprocess", () => {
    const rec = new VoiceRecordingRuntime({
      segments: [pcmSegment("user", 0, 0.3, "test")],
    });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-mp3-"));
    const path = join(dir, "out.mp3");
    rec.save(path, "mp3");
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(0);
    // MP3 frame sync magic — first byte is always 0xFF, second top three bits set.
    const bytes = readFileSync(path);
    // Accept ID3 tag prefix; otherwise expect MP3 sync.
    const isID3 = bytes.subarray(0, 3).toString("ascii") === "ID3";
    if (!isID3) {
      expect(bytes[0]).toBe(0xff);
      expect((bytes[1] & 0xe0) >>> 5).toBe(0b111);
    }
  });

  it("rejects formats outside the allowlist before invoking ffmpeg", () => {
    const rec = new VoiceRecordingRuntime({
      segments: [pcmSegment("user", 0, 0.1)],
    });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-bad-"));
    expect(() => rec.save(join(dir, "out.exe"), "exe")).toThrowError(
      /not supported/i,
    );
  });
});

describe("VoiceRecordingRuntime.saveSegments", () => {
  it("writes one WAV per segment plus full.wav and manifest.json", () => {
    const segments: AudioSegment[] = [
      pcmSegment("user", 0.0, 0.1, "hi"),
      pcmSegment("agent", 0.1, 0.3, "hello"),
    ];
    const timeline: VoiceEvent[] = [
      { time: 0.0, type: "user_start_speaking" },
      { time: 0.1, type: "user_stop_speaking" },
      { time: 0.12, type: "agent_start_speaking", latency: 0.02 },
      { time: 0.3, type: "agent_stop_speaking" },
    ];
    const rec = new VoiceRecordingRuntime({ segments, timeline });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-segs-"));
    rec.saveSegments(dir);

    // segments/<idx>-<role>-<startMs>ms.wav
    const userSeg = readFileSync(join(dir, "segments", "00-user-0000ms.wav"));
    expect(userSeg.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const agentSeg = readFileSync(join(dir, "segments", "01-agent-0100ms.wav"));
    expect(agentSeg.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // full.wav
    const full = readFileSync(join(dir, "full.wav"));
    expect(full.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // manifest.json schema
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(typeof manifest.generated_at).toBe("string");
    expect(manifest.segment_count).toBe(2);
    expect(manifest.segments).toHaveLength(2);
    expect(manifest.segments[0].role).toBe("user");
    expect(manifest.segments[0].file).toBe("segments/00-user-0000ms.wav");
    expect(manifest.segments[0].transcript).toBe("hi");
    expect(manifest.events).toHaveLength(4);
    expect(manifest.events[2].type).toBe("agent_start_speaking");
    expect(manifest.events[2].latency).toBeCloseTo(0.02, 5);
  });

  it("omits the manifest when explicitly disabled", () => {
    const rec = new VoiceRecordingRuntime({
      segments: [pcmSegment("user", 0, 0.05)],
    });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-nomanifest-"));
    rec.saveSegments(dir, { manifest: false });
    expect(() => readFileSync(join(dir, "manifest.json"))).toThrow();
  });

  it("serializes transcript_truncated=true in the manifest when a segment is truncated", () => {
    // Round-trip the transcriptTruncated branch: the manifest must include
    // transcript_truncated: true for segments flagged as cut off by a barge-in.
    const truncatedSeg: AudioSegment = {
      ...pcmSegment("agent", 0.0, 0.2, "I was saying"),
      transcriptTruncated: true,
    };
    const rec = new VoiceRecordingRuntime({ segments: [truncatedSeg] });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-trunc-"));
    rec.saveSegments(dir);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.segments[0].transcript_truncated).toBe(true);
  });

  it("omits transcript_truncated from the manifest for non-truncated segments", () => {
    // Round-trip the absence branch: the manifest must NOT include
    // transcript_truncated for segments that were not cut off.
    const rec = new VoiceRecordingRuntime({
      segments: [pcmSegment("agent", 0.0, 0.2, "full reply")],
    });
    const dir = mkdtempSync(join(tmpdir(), "ts-recording-notrunc-"));
    rec.saveSegments(dir);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.segments[0].transcript_truncated).toBeUndefined();
  });
});

describe("computeLatencyMetrics", () => {
  it("returns avg / p50 / p95 across measurements", () => {
    const stats = computeLatencyMetrics({
      measurements: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      timeToFirstByte: 0.15,
      interruptResponseTime: 0.42,
    });
    expect(stats.avgResponseTime).toBeCloseTo(0.55, 5);
    expect(stats.p50ResponseTime).toBeCloseTo(0.5, 5);
    expect(stats.p95ResponseTime).toBeCloseTo(1.0, 5);
    expect(stats.timeToFirstByte).toBeCloseTo(0.15, 5);
    expect(stats.interruptResponseTime).toBeCloseTo(0.42, 5);
    expect(stats.measurements).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0,
    ]);
  });

  it("leaves derived stats undefined when no measurements are recorded", () => {
    const stats = computeLatencyMetrics({});
    expect(stats.measurements).toEqual([]);
    expect(stats.avgResponseTime).toBeUndefined();
    expect(stats.p50ResponseTime).toBeUndefined();
    expect(stats.p95ResponseTime).toBeUndefined();
  });
});
