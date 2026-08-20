# TypeScript SDK recordings

Audio evidence produced by the TypeScript SDK against **live** providers, kept
because a reviewer needs to hear what a change actually produced. Mirrors
`python/outputs/recordings/` — see that directory's README for the original
statement of the policy.

Everything here is generated. Only the directories whitelisted in `.gitignore`
are committed, and each one exists to answer a specific reviewer question that a
passing test cannot.

| Directory | Recorded | What it proves |
|---|---|---|
| `issue533_voicestyle/` | 2026-07-31 | A `voiceStyle` threaded through the user simulator reaches the real ElevenLabs API and is honoured as a *delivery directive* rather than spoken aloud (issue #533). |

## What each directory contains

- The clips themselves, named for the condition they capture (here: `bare.wav`
  vs `angry.wav` — same sentence, same voice, same model, one variable).
- `manifest.json` — the exact request text put on the wire, byte counts and
  hashes, independent STT transcripts, the checks that ran, and a **`not_proven`
  field** naming what the evidence does *not* establish.
- Screenshots of the harness output, so the PR body can embed proof that lives
  in-tree rather than on a link that rots.

## Reading the evidence

**Byte-difference is not proof.** ElevenLabs `eleven_v3` is non-deterministic:
two identical requests already return different bytes. Any recording here that
claims "styled differs from unstyled" must discriminate on something stronger —
for `issue533_voicestyle/` that is the STT transcript, because `eleven_v3` is the
only EL model that *consumes* an inline `[angry]` marker as a directive instead
of reading it aloud.

## Regenerating

Each `manifest.json` names its `harness`. For `issue533_voicestyle/`:

```bash
cd javascript && ELEVENLABS_API_KEY=... npx tsx scripts/voice-style-live-proof.ts
```

These harnesses spend real provider credits, so they are hand-run and never part
of `vitest run`.
