/**
 * VoiceRecording runtime — WAV/MP3 save + segment directory + JSON manifest.
 *
 * PR1 shipped the type contract (see `recording.types.ts`); this file
 * provides the runtime implementation that an executor populates and that
 * callers reach for via `result.audio.save(...)`. Python parity:
 * `python/scenario/voice/recording.py`.
 *
 * Two output paths:
 * - `save(path)` writes a single conversation file. WAV is written from the
 *   internal PCM16 segments directly; `.mp3` / `.ogg` / `.flac` shell out
 *   to the bundled `ffmpeg` binary (see {@link resolveFfmpegPath}; Python
 *   parity with imageio-ffmpeg) — no system ffmpeg required.
 * - `saveSegments(dir)` writes one WAV per segment plus the full mix and a
 *   JSON manifest pairing files to transcripts/timestamps.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import {
  PCM16_CHANNELS,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
} from "./audio-chunk";
import { resolveFfmpegPath } from "./ffmpeg";
import type {
  AudioSegment,
  LatencyMetrics,
  SpeakerRole,
  VoiceEvent,
  VoiceRecording,
} from "./recording.types";

const ALLOWED_FORMATS = new Set(["wav", "mp3", "ogg", "flac"]);

export interface VoiceRecordingInit {
  segments?: AudioSegment[];
  timeline?: VoiceEvent[];
}

/**
 * Runtime implementation of {@link VoiceRecording}. Stores PCM16 segments
 * and lets callers serialize them as WAV / MP3 / OGG / FLAC or as a
 * segment directory with a JSON manifest.
 *
 * Construction is cheap — the executor creates an empty instance at the
 * start of a voice scenario and appends segments + timeline events as the
 * conversation unfolds.
 */
export class VoiceRecordingRuntime implements VoiceRecording {
  readonly segments: AudioSegment[];
  readonly timeline: VoiceEvent[];

  constructor(init: VoiceRecordingInit = {}) {
    this.segments = init.segments ?? [];
    this.timeline = init.timeline ?? [];
  }

  /** Total duration in seconds (max segment endTime). */
  get duration(): number {
    if (this.segments.length === 0) return 0;
    return this.segments.reduce(
      (max, seg) => (seg.endTime > max ? seg.endTime : max),
      0,
    );
  }

  /** Full mixed/concatenated conversation audio as WAV bytes. */
  get fullWav(): Uint8Array {
    const ordered = [...this.segments].sort(
      (a, b) => a.startTime - b.startTime,
    );
    const totalPcmBytes = ordered.reduce(
      (sum, seg) => sum + seg.audio.length,
      0,
    );
    return encodeWav(ordered.map((s) => s.audio), totalPcmBytes);
  }

  /**
   * Save the full conversation to a file.
   *
   * Format is inferred from the path suffix or overridden by `format`.
   * `.wav` is written natively; non-WAV formats transcode via the bundled
   * ffmpeg subprocess (see {@link resolveFfmpegPath}).
   *
   * `path` is resolved before writing; `format` is validated against an
   * allowlist so callers can't pass arbitrary ffmpeg muxer names.
   */
  save(path: string, format?: string): string {
    const resolved = resolvePath(path);
    const suffix = resolved.split(".").pop()?.toLowerCase() ?? "";
    const fmt = (format ?? suffix ?? "wav").toLowerCase() || "wav";
    if (!ALLOWED_FORMATS.has(fmt)) {
      throw new Error(
        `save(format=${JSON.stringify(fmt)}) not supported; allowed: ` +
          `${[...ALLOWED_FORMATS].sort().join(", ")}`,
      );
    }
    const wavBytes = this.fullWav;
    if (fmt === "wav") {
      writeFileSync(resolved, wavBytes);
      return resolved;
    }

    const result = spawnSync(
      resolveFfmpegPath(),
      [
        "-protocol_whitelist",
        "file,pipe",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-f",
        fmt,
        resolved,
      ],
      { input: Buffer.from(wavBytes) },
    );
    if (result.error) {
      throw new Error(
        `ffmpeg subprocess failed: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `ffmpeg transcode to ${JSON.stringify(fmt)} failed: ` +
          (result.stderr?.toString("utf8") ?? ""),
      );
    }
    return resolved;
  }

  /**
   * Write each segment as its own WAV file plus the full mixed conversation,
   * optionally with a JSON manifest pairing files to transcripts/timestamps.
   *
   * Layout:
   *
   *     <dir>/
   *         segments/
   *             00-user-0000ms.wav
   *             01-agent-0312ms.wav
   *             ...
   *         full.wav
   *         manifest.json   # iff manifest=true
   *
   * Segment file names: zero-padded index, role, start_time in milliseconds.
   * Existing files inside `dir` are NOT cleared — caller decides retention.
   */
  saveSegments(dir: string, options: { manifest?: boolean } = {}): string {
    const includeManifest = options.manifest ?? true;
    const target = resolvePath(dir);
    const segmentsDir = join(target, "segments");
    mkdirSync(target, { recursive: true });
    mkdirSync(segmentsDir, { recursive: true });

    const ordered = [...this.segments].sort(
      (a, b) => a.startTime - b.startTime,
    );
    const entries: Array<Record<string, unknown>> = [];

    ordered.forEach((seg, idx) => {
      const startMs = Math.floor(seg.startTime * 1000);
      const filename = `${pad2(idx)}-${seg.speaker}-${pad4(startMs)}ms.wav`;
      const segPath = join(segmentsDir, filename);
      writeFileSync(segPath, encodeWav([seg.audio], seg.audio.length));

      const entry: Record<string, unknown> = {
        idx,
        file: `segments/${filename}`,
        role: seg.speaker as SpeakerRole,
        start_time: seg.startTime,
        end_time: seg.endTime,
        duration: seg.endTime - seg.startTime,
        transcript: seg.transcript ?? null,
      };
      if (seg.transcriptTruncated) {
        entry.transcript_truncated = true;
      }
      entries.push(entry);
    });

    writeFileSync(join(target, "full.wav"), this.fullWav);

    if (includeManifest) {
      const events: Array<Record<string, unknown>> = [...this.timeline]
        .sort((a, b) => a.time - b.time)
        .map((evt) => {
          const e: Record<string, unknown> = { time: evt.time, type: evt.type };
          if (evt.metadata !== undefined) e.metadata = evt.metadata;
          if (evt.type === "agent_start_speaking" && evt.latency !== undefined) {
            e.latency = evt.latency;
          }
          return e;
        });

      const manifest = {
        generated_at: new Date().toISOString(),
        duration: this.duration,
        segment_count: ordered.length,
        segments: entries,
        events,
      };
      writeFileSync(
        join(target, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
    }

    return target;
  }
}

/**
 * Compute aggregate response-time stats from per-turn measurements.
 *
 * Returned `avgResponseTime` / `p50ResponseTime` / `p95ResponseTime` are
 * `undefined` when `measurements` is empty — matches the Python `Optional`
 * semantics. p95 uses a ceiling-style index so the tail (not the body) is
 * surfaced.
 */
export function computeLatencyMetrics(input: {
  measurements?: readonly number[];
  timeToFirstByte?: number;
  interruptResponseTime?: number;
}): LatencyMetrics {
  const measurements = [...(input.measurements ?? [])];
  if (measurements.length === 0) {
    return {
      measurements,
      timeToFirstByte: input.timeToFirstByte,
      interruptResponseTime: input.interruptResponseTime,
    };
  }
  const sorted = [...measurements].sort((a, b) => a - b);
  const avg = measurements.reduce((s, n) => s + n, 0) / measurements.length;
  const p50 = sorted[Math.floor((sorted.length - 1) / 2)];
  const p95Idx = Math.min(
    sorted.length - 1,
    Math.ceil(0.95 * (sorted.length - 1)),
  );
  return {
    measurements,
    timeToFirstByte: input.timeToFirstByte,
    interruptResponseTime: input.interruptResponseTime,
    avgResponseTime: avg,
    p50ResponseTime: p50,
    p95ResponseTime: sorted[p95Idx],
  };
}

// ---------------------------------------------------------------- helpers

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

/**
 * Build a canonical WAV byte stream from a list of PCM16 segments. The
 * RIFF header is little-endian and matches what `wave.open(buf, "wb")`
 * produces in Python for the canonical format (PCM16, 24kHz, mono).
 */
function encodeWav(
  segments: readonly Uint8Array[],
  totalPcmBytes: number,
): Uint8Array {
  const byteRate =
    PCM16_SAMPLE_RATE * PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const blockAlign = PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const headerSize = 44;
  const out = new Uint8Array(headerSize + totalPcmBytes);
  const view = new DataView(out.buffer);

  // RIFF chunk descriptor
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + totalPcmBytes, true);
  writeAscii(out, 8, "WAVE");

  // fmt sub-chunk
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, PCM16_CHANNELS, true);
  view.setUint32(24, PCM16_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM16_SAMPLE_WIDTH_BYTES * 8, true);

  // data sub-chunk
  writeAscii(out, 36, "data");
  view.setUint32(40, totalPcmBytes, true);

  let offset = headerSize;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.length;
  }
  return out;
}

function writeAscii(out: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    out[offset + i] = value.charCodeAt(i);
  }
}
