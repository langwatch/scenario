# Voice demo recordings (TypeScript)

This directory holds the canonical audio evidence for the TypeScript voice
port (issue #372) — the "prove it" artifacts. Each subdirectory corresponds
to an `@e2e` demo test under
`javascript/examples/vitest/tests/voice/*.test.ts` and contains:

- `full.wav` — the entire conversation, single mixed-down WAV (PCM16, 24 kHz,
  mono).
- `manifest.json` — per-turn timing, role, and transcript plus the voice
  event timeline (the runtime `VoiceRecording.saveSegments` schema:
  `generated_at` / `duration` / `segment_count` / `segments` / `events`).
- `segments/` — per-turn WAV files (committed only for the core-provider
  demos; omitted for the others to keep the tree thin while still preserving
  `full.wav` + `manifest.json`).

Reviewers can play `full.wav` to hear what the demo actually produced and read
the manifest to see which turns were exchanged, when, and what was said. This
mirrors `python/recordings/` exactly — same on-disk shape, same policy.

## How these are produced

Each demo test calls `scenario.run(...)` against a REAL provider (no mocks),
then `saveDemoRecording(result.audio, "<demo>")`
(`examples/vitest/tests/voice/helpers/save-demo-recording.ts`, the TS mirror
of `python/examples/voice/_recording_helper.py`) writes this directory shape.

```bash
cd javascript/examples/vitest
# keys live in examples/vitest/.env (gitignored); source then run:
set -a && . ./.env && set +a
npx vitest run tests/voice/openai-realtime-agent.test.ts
```

## What's committed

| Demo | Provider path | Recorded | What it proves |
|---|---|---|---|
| `openai_realtime_agent/` | OpenAI Realtime (`role=AGENT`) | full.wav + segments | BASELINE. User-sim TTS → Realtime model (the agent under test) → judge verdict, all via `scenario.run()`. `result.audio` populated. |

> The committed set grows as each `@e2e` demo runs cleanly with real keys.
> Demos that fail on a transient (rate-limit / transport) are skipped and
> noted in `docs/voice/REFACTOR-PROGRESS.md` rather than faked.

The `@ts-e2e` round-trip **gate** (`tests/voice/ts-e2e-roundtrip.test.ts`,
`docs/voice/internal-design.md` §8) does not commit a recording — it is a
pass/fail fidelity assertion (utterance survives TTS → message bus → STT),
the regression guard for the Gap #3 audio-format bug.

## Referencing recordings from docs

User-facing docs that reference these recordings should link to the GitHub
**blob** URL after merge to main, e.g.:

```
https://github.com/langwatch/scenario/blob/main/javascript/recordings/openai_realtime_agent/full.wav
```

The blob page renders an inline `<audio>` player at the top of the file view;
a `raw.githubusercontent.com` URL serves the WAV as an attachment (download)
rather than playing it inline.
