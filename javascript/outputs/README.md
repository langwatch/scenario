# TypeScript SDK artifacts

Sibling of `python/outputs/` — the parent directory for checked-in "prove it"
artifacts produced by the TypeScript SDK. Room for `traces/`, `logs/`,
`screenshots/` later; `recordings/` is the audio subdir and the only one
whitelisted in `.gitignore` today.

Everything under here is generated. Only the explicitly whitelisted
subdirectories are committed, and only because a reviewer needs to hear or see
what a change actually produced against a live provider — a passing test cannot
carry that.

## `recordings/`

| Directory | Recorded | What it proves |
|---|---|---|
| `issue533_voicestyle/` | 2026-07-31 | A `voiceStyle` threaded through the user simulator reaches the real ElevenLabs API and is honoured as a delivery directive rather than spoken aloud (issue #533). Play `bare.wav` against `angry.wav`; `manifest.json` carries the requests, hashes, and Scribe transcripts. |

Regenerate with the harness named in each `manifest.json` — for
`issue533_voicestyle/` that is:

```bash
cd javascript && ELEVENLABS_API_KEY=... npx tsx scripts/voice-style-live-proof.ts
```
