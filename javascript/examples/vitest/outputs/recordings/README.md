# Voice demo recordings (TypeScript)

This directory holds the audio outputs produced by the TypeScript voice
port's `@e2e` demo tests (issue #372) — the canonical recordings + per-turn
manifests that serve as "prove it" artifacts. It is the `recordings/`
subdirectory of `outputs/`; see the [parent README](../README.md) for the
artifact-parent shape (future siblings: `traces/`, `logs/`, `screenshots/`).
Each subdirectory here corresponds to a demo test under
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

EVERY committed demo is a MULTI-TURN conversation (≥2 full user↔agent
exchanges, except where a live transport limits it — noted below). "Core"
demos commit `full.wav` + `manifest.json` + per-turn `segments/`; "additional"
demos commit `full.wav` + `manifest.json` only (segments `.gitignore`d), and
long conversations downsample `full.wav` to 8kHz to stay under the 1MB
per-file commit cap (duration — and the M1 manifest invariant — is unchanged).

### Multi-turn provider demos

| Demo | Provider path | Recorded | Turns | What it proves |
|---|---|---|---|---|
| `openai_realtime_agent/` | OpenAI Realtime (`role=AGENT`) | full.wav + segments | 2 exchanges | BASELINE. Multi-turn user-sim TTS → Realtime model → judge, all via `scenario.run()`. |
| `openai_realtime_user/` | OpenAI Realtime (`role=USER`) | full.wav + segments | 2 spoken | Two scripted `user("text")` lines → natural-prosody spoken audio (TTS bypassed). |
| `elevenlabs_hosted/` | live ElevenLabs ConvAI WS | full.wav + segments | greeting + 1 | Live hosted ConvAI socket. Single scripted exchange — the server-VAD transport does not re-engage for a scripted 2nd turn (documented). |
| `elevenlabs_branded/` | EL STT + LLM + EL TTS (in-process) | full.wav + segments | 2 exchanges | Multi-turn branded composable agent; STT/LLM/TTS seams each fire. |
| `gemini_live/` | Gemini Live native audio | full.wav + segments | 2 exchanges | Multi-turn native-audio session (the model replies to both turns; the trailing agent audio segment can be dropped by Gemini's drain — documented). |
| `composable_stt_swap/` | `run({ voice: { stt } })` | full.wav + manifest | 2 exchanges | Swapped EL STT transcribes BOTH agent turns (transcribe() calls = 2). |
| `recording_playback/` | OpenAI Realtime, `save()` WAV+MP3 | full.wav + manifest | 2 exchanges | Multi-turn conversation saved as WAV + MP3. |
| `voice_text_parity/` | same entrypoint, voice vs text | full.wav + manifest | 2 exchanges | Identical multi-turn script through `scenario.run()` for text and voice. |
| `pipecat_ws/` | live Pipecat bot (mulaw/8000) | full.wav + manifest | 2 exchanges | Multi-turn over the live Pipecat WebSocket. |
| `pipecat_scenario/` | live Pipecat bot | full.wav + manifest | 2 exchanges | The designated TRANSPORT SMOKE — proves the adapter round-trips audio both ways over the WS; makes NO conversation-quality / cut-off claim (those are the other demos'). |
| `basic_greeting/` | live Pipecat bot | full.wav + manifest | greeting + 2 | §6.1. The caller asks for something SPECIFIC (order a pizza → delivery time); the judge requires the agent to ENGAGE the request, so a canned-greeting bot fails. The bundled bot is OpenAI-LLM-backed and answers about the order/delivery. |

### Interruption / barge-in demos (the flagship voice capability)

These now prove a REAL cut-off, not just that a `user_interrupt` event fired.
The executor (a) waits for the agent to actually start speaking before barging
in (`agentSpeakingEvent`), so the interrupt lands mid-utterance, and (b) marks
the interrupted agent segment `transcriptTruncated`. Each demo asserts in CODE
that ≥1 agent segment was cut off (`transcriptTruncated`, shorter than a full
reply); the judge criteria cover the conversational half (recovery, topic
pivot) — the judge cannot see truncation from a transcript.

| Demo | Path | Recorded | Cut-off captured | What it proves |
|---|---|---|---|---|
| `interruption_recovery/` | live Pipecat bot | full.wav + manifest | ✅ truncated≥1 | §6.2. `agent({ wait: false }) + user()` and `interrupt()` fire real barge-ins (`fired_after_speech`); ≥1 agent reply truncated + recovery audio after. Judge: recovered + engaged the user's specific requests. |
| `random_interruptions/` | live Pipecat bot | full.wav + manifest | ✅ truncated≥1 | §6.7. `interruptProbability` + `voiceProceed({ interruptions })` cut off agent turns across the run (e.g. interrupts=4, truncated=2). Judge: recovered context. |
| `gemini_live_interruption/` | live Gemini Live | full.wav + manifest | ✅ truncated≥1 | Server-VAD barge-in on Gemini (NO client cancel). Verbose prompt → long reply cut short; the cut-off segment is flagged truncated (clock-agnostic marking, since Gemini receives faster than real-time). |
| `elevenlabs_interruption/` | live EL ConvAI | full.wav + manifest | ✅ truncated≥1 | Un-gated after 3/3 clean live runs (#731). A successful run captures TWO truncated agent segments + a pivot to business hours. Skips when ElevenLabs or OpenAI credentials are absent. NOT faked — the code asserts a real truncated segment. Mechanism also proven non-flakily on Gemini (same server-VAD class). |

### Persona / pain-pattern demos

The cafe noise is now REAL audio (the bundled assets are 3s of distinct,
audible ambience, and the dist-bundle asset-path bug that made `backgroundNoise`
a silent no-op is fixed). Each demo asserts in CODE that the ambience was
actually MIXED onto the user audio (the user-segment noise FLOOR is well above
digital silence — clean TTS is ~0).

| Demo | Path | Recorded | What it proves |
|---|---|---|---|
| `angry_customer/` | live Pipecat bot | full.wav + manifest | §6.3. `voice="elevenlabs/EXAVITQu4vr4xnSDxMaL"` + persona with inline `[shouting]`/`[angry]` tonal markers → AUDIBLE anger (not a neutral voice reading angry text); `audioEffects: [backgroundNoise("cafe", 0.4), phoneQuality()]`. Judge: empathy + concrete resolution + heightened persona. CODE: user noise floor ≫ silence (mixed, not no-op). |
| `background_handoff/` | live Pipecat bot | full.wav + manifest | §8. "hold on" → `silence()` → return; `backgroundNoise("cafe", 0.5)` overheard side-conversation. Judge: agent re-engaged the caller's specific return. CODE: cafe ambience audibly mixed (noise floor ≫ silence). |

> `twilio_inbound` / `twilio_outbound` stay MANUAL (`⏸`) — they need a second
> phone number + a public tunnel (`NGROK_AUTHTOKEN`), absent in this env.
> Demos that fail on a transient (rate-limit / transport) are skipped, with a
> `[demo] <name> → skipped (<reason>)` line in the test log — never faked.

The `@ts-e2e` round-trip **gate** (`tests/voice/ts-e2e-roundtrip.test.ts`,
`docs/adr/003-voice-internal-design.md` §8) does not commit a recording — it is a
pass/fail fidelity assertion (utterance survives TTS → message bus → STT),
the regression guard for the Gap #3 audio-format bug.

## Referencing demo outputs from docs

User-facing docs that reference these demo recordings should link to the
GitHub **blob** URL after merge to main, e.g.:

```
https://github.com/langwatch/scenario/blob/main/javascript/examples/vitest/outputs/recordings/openai_realtime_agent/full.wav
```

The blob page renders an inline `<audio>` player at the top of the file view;
a `raw.githubusercontent.com` URL serves the WAV as an attachment (download)
rather than playing it inline.
