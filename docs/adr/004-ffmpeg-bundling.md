# ADR-004: Bundle ffmpeg via `ffmpeg-static` in `dependencies` (#350)

**Date:** 2026-06-05

**Status:** Accepted

**Companion docs:** [ADR-001 Concurrency](./001-scenario-concurrency-model.md) · [ADR-002 Voice Provider State](./002-voice-provider-state.md) · [ADR-003 Voice Internal Design](./003-voice-internal-design.md)

_This is an Engineering Design Record. Committed at repo-root `docs/adr/004-ffmpeg-bundling.md` alongside ADR-001/002/003 (not under `javascript/docs/`)._

## Why this doc exists

The JS SDK depends on a full ffmpeg binary at runtime, shipped via `ffmpeg-static`
in the **`dependencies`** tier — not `optionalDependencies`, not `peerDependencies`,
not a system install. This is a ~30–80 MB binary that **every consumer of the SDK
pays for at install time, including text-only users who never touch voice.** That is
a load-bearing, non-obvious cost, and the closest external peer (LiveKit Agents) made
the opposite placement call. So the choice deserves a record: what was decided, why
the `dependencies` tier specifically, and what tension remains open.

## Context — three shipped features need a transcoder

The SDK's canonical internal audio format is **PCM16 @ 24 kHz mono**
(`javascript/src/voice/audio-chunk.ts:13` — `export const PCM16_SAMPLE_RATE = 24000;`).
WAV is the only container the SDK reads/writes natively; everything else is a real
codec.

Three shipped voice features require a transcoder between PCM16/WAV and other formats:

1. **Non-WAV recording export** — `VoiceRecordingRuntime.save()`
   (`javascript/src/voice/recording.runtime.ts:63`). `.wav` is written natively;
   `mp3`/`ogg`/`flac` shell out to ffmpeg (`spawnSync` at line 79).
2. **Local-speaker playback** — `AudioPlaybackSink.open()`
   (`javascript/src/voice/playback.ts:74`) spawns ffmpeg to decode PCM16 to the
   platform audio device.
3. **Decode-at-ingest** — `audio()` script step
   (`javascript/src/script/voice-steps.ts:97`) auto-converts an injected
   WAV/MP3/OGG/FLAC file (or bytes) to PCM16 @ 24 kHz via an ffmpeg `spawnSync`
   (transcode site at `voice-steps.ts:~508`).

**WAV is hand-written, verified.** There is no ffmpeg on the WAV path. Two
independent native RIFF encoders exist:

- `encodeWav()` in `javascript/src/voice/recording.runtime.ts:275` — writes the 44-byte
  RIFF/`WAVE`/`fmt `/`data` header by hand via `DataView`, then copies PCM segments.
- `pcm16ToWav()` in `javascript/src/voice/stt/wav.ts:18` — the STT upload-edge wrapper
  (OpenAI/ElevenLabs accept a WAV container, not raw PCM16).

  > Note: the path is `javascript/src/voice/stt/wav.ts` (under `voice/`), not
  > `javascript/src/stt/wav.ts`.

mp3/ogg/flac encoders are **not** hand-written and will not be — a maintained,
spec-correct MP3/Vorbis/FLAC encoder is a large, ongoing surface that ffmpeg already
owns.

## Decision

**Bundle ffmpeg via `ffmpeg-static` in the `dependencies` tier of the JS SDK.**

- `javascript/package.json:63` — `"ffmpeg-static": "5.3.0"`, inside the
  `"dependencies"` block (not `optionalDependencies`/`peerDependencies`).
- `resolveFfmpegPath()` (`javascript/src/voice/ffmpeg.ts`) returns the absolute path
  to the bundled binary when it exists on disk, and **falls back to the literal
  `"ffmpeg"` on PATH** when the bundle is unavailable for the platform/arch (the
  `ffmpeg-static` default export is `null` on unsupported platforms) — so callers
  degrade to a system ffmpeg rather than failing with ENOENT on a non-existent path.

Bundling (vs. requiring a system ffmpeg) means voice record/playback/ingest works for
any consumer with no separate install, and CI runners without system ffmpeg pass too.

## Python parity is the primary justification for the `dependencies` tier

The Python SDK ships the **same architecture, in the same tier**: a hard dependency on
a pip-bundled ffmpeg, WAV native / non-WAV shelled out, the same muxer allowlist, the
same error-string shape. The two SDKs are meant to be behaviorally symmetric, and the
tier placement follows from that symmetry.

- **Hard dep, same intent.** `python/pyproject.toml:50` — `"imageio-ffmpeg>=0.5.0"`,
  in the core `dependencies` array. The comment immediately above it
  (`python/pyproject.toml:47`) reads, verbatim:

  > `# Voice agent support (issue #350). Hard deps: voice is first-class.`
  > `# imageio-ffmpeg bundles the ffmpeg binary (not ffplay) for audio`
  > `# conversion and playback-via-subprocess.`

  `imageio-ffmpeg` is pip's equivalent of `ffmpeg-static` — it bundles the ffmpeg
  binary so there is no system dependency. `resolveFfmpegPath()` even documents the
  parity: Python calls `imageio_ffmpeg.get_ffmpeg_exe()`, JS reads the
  `ffmpeg-static` default export.

- **Same muxer allowlist.** JS restricts non-WAV formats to a fixed set so a caller
  can't pass an arbitrary ffmpeg muxer name:
  `javascript/src/voice/recording.runtime.ts:36` —
  `const ALLOWED_FORMATS = new Set(["wav", "mp3", "ogg", "flac"]);`. Python mirrors it
  exactly: `python/scenario/voice/recording.py:140` —
  `_ALLOWED_FORMATS = frozenset({"wav", "mp3", "ogg", "flac"})`.

- **Same error-string shape.** JS throws
  `save(format=...) not supported; allowed: ...`
  (`recording.runtime.ts:68`); Python raises the byte-for-byte equivalent
  `save(format={fmt!r}) not supported; allowed: ...` (`recording.py:159`).

Because the Python SDK already commits voice as a first-class hard dependency, the JS
SDK matches that contract — `dependencies`, not optional. Parity on the design, not
on a divergent install story.

## Alternatives considered & rejected

- **System ffmpeg (`apt install ffmpeg` / on PATH only).** Rejected. Breaks the
  hermetic install promise: fresh dev boxes and CI runners without ffmpeg would fail at
  runtime, version drift across machines produces non-reproducible transcodes, and
  Windows/macOS consumers have no `apt`. Bundling makes the binary version a property
  of the lockfile, not the host. (The PATH fallback in `resolveFfmpegPath()` is a
  graceful degradation, **not** the primary mechanism.)

- **Pure-JS encoders (e.g. `lamejs`).** Rejected. MP3-only — no ogg/flac, which the
  allowlist promises. `lamejs` is effectively unmaintained, and hand-owning correct
  Vorbis/FLAC encoders is exactly the maintenance surface ffmpeg exists to absorb.

- **`ffmpeg.wasm`.** Rejected. The wasm build is ~30 MB anyway (no size win over the
  static binary), runs slower than a native subprocess, and — decisively — would
  diverge from Python, which shells out to a real ffmpeg process. Subprocess parity
  with Python (same `spawn` arg shapes, same error surfacing) is worth more than a
  same-process codec.

## Consequences / accepted costs

- **Install-time weight for everyone.** Every consumer pays ~30–80 MB at install
  (the resolved binary on this machine is ~45 MB), **including text-only users who
  never invoke a voice feature.** Accepted as the cost of Python parity and the
  "voice is first-class" stance.

- **Postinstall is a supply-chain surface — and the allowlist is correctly set
  (corrected against an earlier claim).** `ffmpeg-static@5.3.0` downloads its platform
  binary via a **postinstall/`install` script** — its `package.json` declares
  `"scripts": { "install": "node install.js" }`. pnpm denies build scripts by default,
  so this download only runs if `ffmpeg-static` is in the `onlyBuiltDependencies`
  allowlist. **It is.** `javascript/pnpm-workspace.yaml:15` lists `ffmpeg-static` in
  `onlyBuiltDependencies` (alongside `esbuild`, `unrs-resolver`, `@swc/core`,
  `sharp`), with an explanatory comment at lines 12–14:

  > `# ffmpeg-static downloads the platform ffmpeg binary in its postinstall;`
  > `# without this allowlist pnpm skips the script and resolveFfmpegPath()`
  > `# would point at a non-existent file (and CI would still lack ffmpeg).`

  **Verified end-to-end:** from `javascript/`,
  `require("ffmpeg-static")` resolves to
  `.../node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg` and
  `fs.existsSync(path)` returns `true` (a ~45 MB executable is present). The allowlist
  entry is load-bearing: **without it, pnpm would skip the postinstall download and
  `resolveFfmpegPath()` would silently fall through to a system `ffmpeg` on PATH** —
  which on a bare CI runner is absent, so non-WAV transcode would fail at runtime. The
  entry's presence is what makes the bundled-binary guarantee real; its absence would
  be a latent install bug. (An earlier defense of this decision claimed the allowlist
  entry was *missing*; that was false against the current `main` — it is present, with
  a comment.)

- **Dead weight on the pure-WAV happy path.** A consumer who only ever records/exports
  WAV never spawns ffmpeg (the WAV branch is fully native), yet still carries the
  binary. Accepted.

## Open question / revisit trigger — placement diverges from the LiveKit norm

`dependencies` placement is defensible by Python-parity, but it is a **known
divergence** from the closest open-source peer.

**LiveKit Agents** — an open-source voice SDK that, like scenario, ships to consumers
who `pip install` it — bundles ffmpeg too (via PyAV's in-wheel binaries) but gates it
behind an **optional extra**: `pip install livekit-agents[codecs]`, with a graceful
`ImportError` when the extra is absent
(`Please install the 'codecs' extra by running \`pip install livekit-agents[codecs]\``).
Text-only users pay nothing. See
<https://docs.livekit.io/python/livekit/agents/utils/codecs/index.html> and
<https://pypi.org/project/av/>.

**Vapi** sidesteps the question entirely by being a hosted service — users install
nothing locally.

So the norm among shipping voice SDKs leans toward *optional* codec deps with a
graceful fallback. scenario chose `dependencies` for two-SDK symmetry, eyes open.

**Revisit trigger (deliberately deferred, NOT decided against here):** demoting
`ffmpeg-static` to `optionalDependencies` with a graceful
"install `ffmpeg-static` or set an ffmpeg-path env var" fallback for the text-only
crowd is a legitimate future change. `resolveFfmpegPath()`'s existing PATH fallback
is already most of the mechanism. It would need to be done in lockstep across both
SDKs (Python would move `imageio-ffmpeg` to an extra) to preserve parity. **This is
its own issue, not this ADR's call** — recorded here so the trade is visible the next
time install size or supply-chain surface comes up for review.
