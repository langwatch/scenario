/**
 * Local-speaker audio playback sink — TypeScript parity for
 * `python/scenario/voice/playback.py`.
 *
 * Spawns an `ffmpeg` subprocess (using the bundled `ffmpeg-static` binary) that
 * reads PCM16 mono 24kHz from stdin and writes to the platform audio output
 * driver. Degrades gracefully on headless systems — when `ffmpeg` fails to open
 * the audio device, it emits a single debug warning and silently no-ops for the
 * rest of the run so the scenario output is not interrupted.
 *
 * Design:
 * - `AudioPlaybackSink.open()` spawns the subprocess once per run (called by
 *   the executor when `audioPlayback === true`).
 * - `sendChunk(chunk)` writes PCM bytes to the subprocess stdin.
 * - `close()` signals EOF and waits for the subprocess to drain.
 *
 * The Python implementation uses imageio-ffmpeg's bundled binary and the same
 * platform-audio-driver selection logic; this file mirrors it exactly.
 *
 * CI / headless: when no audio device is available `ffmpeg` exits with a
 * non-zero status or writes to stderr and `this._active` stays `false` so
 * `sendChunk` becomes a no-op. The failing subprocess is reaped via `close()`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { platform } from "node:os";
import type { Writable, Readable } from "node:stream";

import type { AudioChunk } from "./audio-chunk";
import { PCM16_SAMPLE_RATE } from "./audio-chunk";
import { resolveFfmpegPath } from "./ffmpeg";

// -----------------------------------------------------------------------
// Platform audio driver selection (mirrors Python's _platform_audio_output_args)
// -----------------------------------------------------------------------

function platformAudioOutputArgs(): string[] {
  const sys = platform();
  if (sys === "darwin") {
    return ["-f", "audiotoolbox", "-"];
  }
  if (sys === "win32") {
    return ["-f", "dshow", "audio=default"];
  }
  // Linux and all other platforms: ALSA
  return ["-f", "alsa", "default"];
}

// -----------------------------------------------------------------------
// AudioPlaybackSink
// -----------------------------------------------------------------------

/**
 * Stateful playback session. Spawns an ffmpeg subprocess on `open()` and
 * fans out each agent/user audio chunk to the platform speakers via stdin.
 *
 * Gracefully no-ops when no audio device is available (headless CI).
 * A single `console.warn` is emitted the first time the device is unavailable;
 * subsequent `sendChunk` calls are silently dropped.
 */
export class AudioPlaybackSink {
  private _proc: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private _active = false;
  private _warnedOnce = false;

  /**
   * Spawn the ffmpeg subprocess. Must be called once before any `sendChunk`.
   *
   * Failures (no ffmpeg binary, no audio device) are caught here and logged
   * as a single warning; `sendChunk` becomes a no-op for the rest of the run.
   */
  open(): void {
    const ffmpeg = resolveFfmpegPath();
    const args = [
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      String(PCM16_SAMPLE_RATE),
      "-i",
      "pipe:0",
      ...platformAudioOutputArgs(),
    ];

    try {
      const proc = spawn(ffmpeg, args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
      this._proc = proc;
      this._active = true;

      // Treat any error event (binary not found, ENOENT) as a device failure.
      proc.on("error", (err: Error) => {
        if (!this._warnedOnce) {
          this._warnedOnce = true;
          console.warn(
            `[scenario] audioPlayback: failed to start ffmpeg subprocess — ` +
              `audio will not be played locally. (${err.message}) ` +
              `This is normal on headless CI.`,
          );
        }
        this._active = false;
        this._proc = null;
      });

      // If ffmpeg exits early (no audio device), deactivate.
      // Mirror the error handler: also null out _proc so close() short-circuits
      // via the existing `if (!this._proc)` guard instead of hanging waiting for
      // an exit event that already fired.
      proc.on("exit", (code: number | null) => {
        if (code !== 0 && code !== null) {
          if (!this._warnedOnce) {
            this._warnedOnce = true;
            console.warn(
              `[scenario] audioPlayback: ffmpeg exited with code ${code} — ` +
                `no audio device available. Audio will not be played locally. ` +
                `This is normal on headless CI.`,
            );
          }
          this._active = false;
          this._proc = null;
        }
      });
    } catch (err) {
      if (!this._warnedOnce) {
        this._warnedOnce = true;
        console.warn(
          `[scenario] audioPlayback: failed to spawn ffmpeg — ` +
            `audio will not be played locally. ` +
            `(${err instanceof Error ? err.message : String(err)}) ` +
            `This is normal on headless CI.`,
        );
      }
      this._active = false;
      this._proc = null;
    }
  }

  /**
   * Write a PCM16 audio chunk to the playback subprocess stdin.
   * No-ops when the sink is inactive (open() failed or device unavailable).
   */
  sendChunk(chunk: AudioChunk): void {
    if (!this._active || !this._proc || !this._proc.stdin) return;
    try {
      this._proc.stdin.write(Buffer.from(chunk.data));
    } catch {
      // stdin closed unexpectedly — deactivate silently.
      this._active = false;
    }
  }

  /**
   * Signal EOF and wait for the subprocess to drain.
   * Called at the end of a voice run to ensure all queued audio is played.
   *
   * Safe to call when the sink was never opened or already closed.
   */
  close(): Promise<void> {
    const proc = this._proc;
    if (!proc) {
      this._active = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._active = false;
      this._proc = null;
      try {
        if (proc.stdin) {
          proc.stdin.end();
        }
      } catch {
        // Ignore — stdin may already be closed.
      }
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve()); // Ensure we always resolve.
    });
  }

  /** True when the subprocess is active and accepting chunks. */
  get active(): boolean {
    return this._active;
  }
}
