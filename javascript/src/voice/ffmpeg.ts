/**
 * Resolve the ffmpeg binary path for voice audio transcode/decode.
 *
 * Python parity: `python/scenario/voice/script_steps.py` resolves
 * `imageio_ffmpeg.get_ffmpeg_exe()` — a bundled binary, no system dependency.
 * The TypeScript SDK bundles ffmpeg the same way via `ffmpeg-static`, whose
 * default export is the absolute path to a platform binary downloaded in its
 * postinstall step (see `pnpm-workspace.yaml` `onlyBuiltDependencies`).
 *
 * Bundling (rather than shelling out to a system `ffmpeg` on PATH) means voice
 * recording/playback works for any consumer of the SDK without a separate
 * ffmpeg install, and CI runners without system ffmpeg pass too.
 */

import { existsSync } from "node:fs";

import ffmpegStatic from "ffmpeg-static";

/** PATH fallback command used when the bundled binary is unavailable. */
const FFMPEG_ON_PATH = "ffmpeg";

/**
 * Absolute path to the bundled ffmpeg binary, or the literal `"ffmpeg"` when
 * the bundle is unavailable on this platform.
 *
 * `ffmpeg-static`'s default export is the absolute binary path, or `null` on a
 * platform/arch it doesn't ship a binary for. We additionally fall back when
 * the resolved path doesn't exist on disk — e.g. the postinstall download was
 * skipped — so callers degrade to a system `ffmpeg` on PATH instead of failing
 * with ENOENT on a non-existent bundled path.
 *
 * @returns the binary path/command to pass to `spawn`/`spawnSync`.
 */
export function resolveFfmpegPath(): string {
  const bundled = ffmpegStatic as string | null;
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  return FFMPEG_ON_PATH;
}
