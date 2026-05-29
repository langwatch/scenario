/**
 * Shared helper used by all voice demos to write recordings to disk.
 *
 * TypeScript mirror of `python/examples/voice/_recording_helper.py`. The
 * library itself stays neutral — only the demo tests write to disk. A demo
 * calls {@link saveDemoRecording} with `result.audio` and a demo name; the
 * helper lands a `full.wav` + `segments/` + `manifest.json` under
 * `javascript/examples/vitest/outputs/recordings/<demoName>/` via the runtime's
 * {@link VoiceRecording.saveSegments} (the same on-disk shape the Python
 * demos produce — `generated_at` / `duration` / `segment_count` / `segments`
 * / `events`).
 *
 * Returns the directory path when audio with ≥1 segment was written, or
 * `null` when `audio` is absent / empty (a transport that never produced a
 * turn) — the demo treats `null` as "nothing to commit", exactly like the
 * Python helper's `Optional[Path]` return.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { voice } from "@langwatch/scenario";

const HERE = dirname(fileURLToPath(import.meta.url));
// helpers/ → tests/voice → tests → vitest → outputs/recordings.
// Workspace-local: outputs (recordings + manifest) live next to the vitest
// package that produces them, not at the JS workspace root. Resolves the same
// regardless of CWD, matching the Python helper's `__file__`-anchored
// `_RECORDINGS_ROOT`. `outputs/` is the future-proof artifact parent (room
// for traces/, logs/, screenshots/ later); `recordings/` is the audio subdir.
const RECORDINGS_ROOT = resolve(
  HERE,
  "..",
  "..",
  "..",
  "outputs",
  "recordings",
);

/**
 * The slice of {@link voice.VoiceRecording} this helper needs: the segment
 * list (to decide whether there is anything to write) and `saveSegments`
 * (to write it). `result.audio` is a `VoiceRecordingRuntime` at runtime —
 * typed loosely here so the helper compiles against the published d.ts
 * without importing internals.
 */
type SavableRecording = Pick<voice.VoiceRecording, "segments"> & {
  saveSegments(dir: string, options?: { manifest?: boolean }): string;
};

/** Options for {@link saveDemoRecording}. */
export interface SaveDemoOptions {
  /**
   * Downsample the committed `full.wav` to this rate (Hz) AFTER writing — the
   * Python-parity commit-cap policy. The recording is captured at 24kHz; a
   * long multi-turn / interruption conversation's 24kHz `full.wav` can exceed
   * the 1MB commit cap, so we re-encode it (e.g. to 8000) which cuts bytes ~3x
   * while leaving the DURATION (and thus the M1 manifest invariant) unchanged.
   * Per-segment WAVs and the manifest are untouched.
   */
  downsampleHz?: number;
}

/**
 * If `audio` is non-null and has segments, write per-segment WAVs + the full
 * mix + a manifest under `javascript/examples/vitest/outputs/recordings/<demoName>/`
 * and return the directory path. Returns `null` when `audio` is null/undefined
 * or has no segments (nothing was recorded — e.g. a transport that never spoke).
 *
 * Mirrors `python/examples/voice/_recording_helper.py:save_demo_recording`.
 */
export function saveDemoRecording(
  audio: SavableRecording | null | undefined,
  demoName: string,
  options: SaveDemoOptions = {},
): string | null {
  if (!audio || !audio.segments || audio.segments.length === 0) {
    return null;
  }
  const target = resolve(RECORDINGS_ROOT, demoName);
  audio.saveSegments(target, { manifest: true });
  pruneOrphanSegments(target);
  if (options.downsampleHz) {
    const fullWav = join(target, "full.wav");
    downsampleFullWav(fullWav, options.downsampleHz);
    // Hard <1MB commit-cap guarantee: a long, non-deterministic conversation
    // can still exceed 1MB at the requested rate, so step the sample rate down
    // (8000 → 6000 → 4000) until the committed full.wav is under budget. The
    // DURATION (and the M1 manifest invariant) is unchanged — only fidelity
    // drops, and this is already a downsampled artefact.
    const CAP_BYTES = 1_000_000;
    for (const hz of [6000, 4000, 3000]) {
      if (!existsSync(fullWav) || statSync(fullWav).size <= CAP_BYTES) break;
      downsampleFullWav(fullWav, hz);
    }
  }
  return target;
}

/**
 * Re-encode `full.wav` in place at `hz` (mono PCM16) via the bundled ffmpeg.
 * Lowering the sample rate cuts the byte size proportionally without changing
 * the playable DURATION, so `manifest.duration` (byte-duration at the new rate)
 * stays equal to the file — the M1 invariant is preserved at the lower rate.
 */
function downsampleFullWav(fullWavPath: string, hz: number): void {
  if (!existsSync(fullWavPath)) return;
  const tmp = `${fullWavPath}.tmp.wav`;
  const result = spawnSync(
    voice.resolveFfmpegPath(),
    [
      "-loglevel",
      "error",
      "-y",
      "-i",
      fullWavPath,
      "-ac",
      "1",
      "-ar",
      String(hz),
      "-c:a",
      "pcm_s16le",
      tmp,
    ],
    {},
  );
  if (result.status === 0 && existsSync(tmp)) {
    rmSync(fullWavPath);
    renameSync(tmp, fullWavPath);
  } else if (existsSync(tmp)) {
    rmSync(tmp);
  }
}

/**
 * Remove `segments/*.wav` files NOT referenced by the freshly-written
 * `manifest.json`. `saveSegments` names each segment by its byte-accurate
 * cursor offset (`NN-<role>-<ms>ms.wav`); a re-run with different timing
 * writes new names but never deletes the previous run's files, so without
 * pruning a multi-turn re-run leaves stale orphans behind (which would then
 * be committed as dead weight). Keeping the directory to exactly the manifest
 * set is the M1 fidelity invariant on disk.
 */
function pruneOrphanSegments(dir: string): void {
  const segDir = join(dir, "segments");
  if (!existsSync(segDir)) return;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    segments?: Array<{ file?: string }>;
  };
  const keep = new Set(
    (manifest.segments ?? [])
      .map((s) => s.file && basename(s.file))
      .filter((f): f is string => Boolean(f)),
  );
  for (const entry of readdirSync(segDir)) {
    if (entry.endsWith(".wav") && !keep.has(entry)) {
      rmSync(join(segDir, entry));
    }
  }
}

/** Absolute path to `javascript/examples/vitest/outputs/recordings/` — exported for demos that need it. */
export { RECORDINGS_ROOT };
