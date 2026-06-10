# Voice demo recordings

This directory holds the canonical audio evidence for PR #355 (issue
#350) — the "prove it" artifacts. Each subdirectory corresponds to a
demo script under `python/examples/voice/` and contains:

- `full.wav` — the entire conversation, single mixed-down WAV.
- `manifest.json` — per-turn timing, role, and judge-grade transcript.
- `segments/` — per-turn WAV files (committed only for the original
  seven core-provider demos; omitted for the others to keep the tree
  thin while still preserving `full.wav` + `manifest.json`).

Reviewers can play the `full.wav` to hear what the demo actually
produced and read the manifest to see exactly which turns were
exchanged, when, and what was said.

## What's committed

Every demo with a verified recording is committed. "Verified" means
the demo's judge passed, OR the demo's judge failed *by design* (the
interruption demos' load-bearing assertion is that the judge catches
missed pivots).

### Core providers (full evidence — segments included)

| Demo | Verdict | Recorded | What it proves |
|---|---|---|---|
| `elevenlabs_hosted/` | PASS (4/4) | 2026-05-12 | Two-turn happy path against EL hosted ConvAI. Greeting on connect, context-aware follow-up. |
| `elevenlabs_branded/` | PASS (4/4) | 2026-05-12 | Branded `ElevenLabsVoiceAgent` (STT/LLM/TTS providers). STT/LLM/TTS seams all fire. |
| `elevenlabs_interruption/` | FAIL by judge (intended) | 2026-05-12 | User barges in mid-utterance; load-bearing judge catches that EL agent fails to pivot to the new topic. |
| `twilio_inbound/` | PASS (3/3) | 2026-05-12 | Real PSTN call into the adapter via Media Streams. Second Twilio number dials in. |
| `twilio_outbound/` | PASS (3/3) | 2026-05-12 | Adapter places outbound REST call; B-leg's `voice_url` is rewritten to attach Media Streams; bidirectional bridge audio. The example's script is a single user turn (`user → agent → judge`, `max_turns=4`); the recording's silence after the agent's reply is by-design (no further user prompts), not a transport drop. |
| `gemini_live/` | PASS | 2026-05-11 | Gemini Live native audio happy path. |
| `gemini_live_interruption/` | PASS | 2026-05-11 | Gemini Live with mid-utterance interruption. |

### Additional providers + cross-cutting (full.wav + manifest only)

| Demo | Recorded | What it proves |
|---|---|---|
| `openai_realtime_agent/` | 2026-05-09 | OpenAI Realtime adapter happy path. |
| `pipecat_scenario/` | 2026-05-08 | Pipecat pipeline driven via scenario.run() (in-process). |
| `pipecat_ws/` | 2026-05-07 | Pipecat over the WebSocket transport. |
| `basic_greeting/` | 2026-05-09 | Minimal one-turn smoke against the default voice stack. |
| `voice_text_parity/` | 2026-05-07 | Same script runs against text + voice agents and produces equivalent verdicts. |
| `recording_playback/` | 2026-05-07 | Recording + playback: `result.audio.save("demo.wav")` and `result.audio.save("demo.mp3")` (via bundled ffmpeg) both write a non-empty file; `audio_playback=True` opens the local audio device to stream the live conversation. Not to be confused with `prerecorded_audio` (Example 6.6), which injects a pre-recorded WAV file as user input. |
| `interruption_recovery/` | 2026-05-09 | Agent recovers gracefully after mid-utterance barge-in. |
| `random_interruptions/` | 2026-05-09 | Fuzz: random user interrupts during agent reply; agent doesn't deadlock. |
| `angry_customer/` | 2026-05-11 | Pain pattern: hostile user; judge grades de-escalation behavior. |
| `background_handoff/` | 2026-05-11 | Pain pattern: user says "hold on" and moves away from the mic while ambient cafe noise plays for several seconds; the agent should wait quietly rather than treat the background audio as user speech. "Handoff" here means the caller temporarily handing the conversation off to background ambience — not a warm transfer to another agent. |

> The "additional" demos' `full.wav` for `interruption_recovery` and
> `angry_customer` were downsampled from PCM16 @ 24kHz to PCM16 @ 8kHz
> to fit pre-commit's 1MB-per-file cap. Voice fidelity is telephony-
> grade; the underlying audio chunks the adapters sent/received remain
> 24kHz at runtime.

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
GitHub **blob** URL after this PR merges to main, e.g.:

```
https://github.com/langwatch/scenario/blob/main/python/outputs/recordings/elevenlabs_hosted/full.wav
```

The blob page renders an inline `<audio>` player at the top of the
file view, so a single click on the link lands the reader on a page
where they can press play. GitHub does **not** auto-render an inline
audio player inside Markdown bodies for raw `.wav` URLs — the
`raw.githubusercontent.com` host serves the file as
`Content-Disposition: attachment`, which most browsers download
rather than play.
