# Voice demo recordings

This directory holds the canonical audio evidence for PR #355 (issue
#350) — the "prove it" artifacts. Each subdirectory corresponds to a
demo script under `python/examples/voice/` and contains:

- `full.wav` — the entire conversation, single mixed-down WAV.
- `manifest.json` — per-turn timing, role, and judge-grade transcript.
- `segments/` — per-turn WAV files, one per speaker turn.

Reviewers can play the `full.wav` to hear what the demo actually
produced and read the manifest to see exactly which turns were
exchanged, when, and what was said.

## What's committed

Only demos with **fresh, verified recordings** are checked in.
A demo is "verified" when its judge passed (or, for the EL
interruption demo, the judge failed *by design* — the demo's
load-bearing assertion is that the judge catches missed pivots).

| Demo | Verdict | Recorded | What it proves |
|---|---|---|---|
| `elevenlabs_hosted/` | PASS (4/4) | 2026-05-12 | Two-turn happy path against EL hosted ConvAI. Greeting on connect, context-aware follow-up. |
| `elevenlabs_branded/` | PASS (4/4) | 2026-05-12 | Branded `ElevenLabsVoiceAgent` (STT/LLM/TTS providers). STT/LLM/TTS seams all fire. |
| `elevenlabs_interruption/` | FAIL by judge (intended) | 2026-05-12 | User barges in mid-utterance; load-bearing judge catches that EL agent fails to pivot to the new topic. |
| `twilio_inbound/` | PASS (3/3) | 2026-05-12 | Real PSTN call into the adapter via Media Streams. Second Twilio number dials in. |
| `twilio_outbound/` | PASS (3/3) | 2026-05-12 | Adapter places outbound REST call; B-leg's `voice_url` is rewritten to attach Media Streams; bidirectional bridge audio. |
| `gemini_live/` | (from prior session) | 2026-05-11 | Gemini Live native audio happy path. |
| `gemini_live_interruption/` | (from prior session) | 2026-05-11 | Gemini Live with mid-utterance interruption. |

## What's NOT committed (yet)

The remaining demos under `python/examples/voice/` either have stale
recordings or none at all. They are intentionally excluded from this
PR's evidence set until they're re-run and verified:

- pipecat_ws, pipecat_scenario
- openai_realtime_agent, openai_realtime_user
- vapi (no demo script)
- pain patterns: angry_customer, background_handoff, accent_loop,
  multi_intent, emotional_escalation, long_hold
- cross-cutting: basic_greeting, interruption_recovery, dtmf_ivr,
  prerecorded_audio, random_interruptions, recording_playback,
  observability, stt_swap, voice_text_parity, silence_handling,
  tool_verification

These will be added in a follow-up commit as each demo is re-verified.

## Running a demo to regenerate its recording

```bash
cd python
uv run examples/voice/<demo>.py
```

The demo's `result.audio.save_segments()` call writes everything in
this directory shape. If you're verifying a new demo for PR evidence,
run it, eyeball the manifest, then update `.gitignore` to un-ignore
the new demo's directory and commit it alongside this README's table.

## Referencing recordings from docs

User-facing docs that reference these recordings should link to the
raw GitHub URL after this PR merges to main, e.g.:

```
https://github.com/langwatch/scenario/raw/main/python/recordings/elevenlabs_hosted/full.wav
```

GitHub renders raw `.wav` URLs as inline audio players in Markdown.
