/**
 * Shared helper used by all voice demos to write recordings to disk.
 *
 * TypeScript mirror of `python/examples/voice/_recording_helper.py`. The
 * library itself stays neutral — only the demo tests write to disk. A demo
 * calls {@link saveDemoRecording} with `result.audio` and a demo name; the
 * helper lands a `full.wav` + `segments/` + `manifest.json` under
 * `javascript/recordings/<demoName>/` via the runtime's
 * {@link VoiceRecording.saveSegments} (the same on-disk shape the Python
 * demos produce — `generated_at` / `duration` / `segment_count` / `segments`
 * / `events`).
 *
 * Returns the directory path when audio with ≥1 segment was written, or
 * `null` when `audio` is absent / empty (a transport that never produced a
 * turn) — the demo treats `null` as "nothing to commit", exactly like the
 * Python helper's `Optional[Path]` return.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { voice } from "@langwatch/scenario";

const HERE = dirname(fileURLToPath(import.meta.url));
// helpers/ → tests/voice → tests → vitest → examples → javascript → recordings.
// Resolves the same regardless of CWD inside the examples workspace, matching
// the Python helper's `__file__`-anchored `_RECORDINGS_ROOT`.
const RECORDINGS_ROOT = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
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

/**
 * If `audio` is non-null and has segments, write per-segment WAVs + the full
 * mix + a manifest under `javascript/recordings/<demoName>/` and return the
 * directory path. Returns `null` when `audio` is null/undefined or has no
 * segments (nothing was recorded — e.g. a transport that never spoke).
 *
 * Mirrors `python/examples/voice/_recording_helper.py:save_demo_recording`.
 */
export function saveDemoRecording(
  audio: SavableRecording | null | undefined,
  demoName: string,
): string | null {
  if (!audio || !audio.segments || audio.segments.length === 0) {
    return null;
  }
  const target = resolve(RECORDINGS_ROOT, demoName);
  audio.saveSegments(target, { manifest: true });
  return target;
}

/** Absolute path to `javascript/recordings/` — exported for demos that need it. */
export { RECORDINGS_ROOT };
