# Voice Agents — Bug Bash Guide

**PR:** [#355](https://github.com/langwatch/scenario/pull/355) · **Issue:** [#350](https://github.com/langwatch/scenario/issues/350) · **Status (2026-05-07):** draft, 280/0 passed locally, 25 e2e voice demos shipped, 1 listened-tested by Drew (`basic_greeting`).

## What we need from you

Run as many of the 20 OpenAI-only demos as you can. **Listen to the recording**, decide if the agent behaved like a sane voice agent, file what's broken or weird. We're not after green test output — we're after "does this sound right?"

## Setup (5 min)

```bash
gh pr checkout 355
cd python
cp .env.example .env       # then fill in OPENAI_API_KEY
uv sync
```

That's it. Each demo auto-spawns the bundled Pipecat stub bot if needed.

### Optional credentials (unlock more demos)

| Cred | Unlocks |
|---|---|
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | `elevenlabs_hosted`, `elevenlabs_branded` |
| `GEMINI_API_KEY` (with Live API) | `gemini_live` |
| `TWILIO_*` (see `dtmf_ivr.py` docstring) | `dtmf_ivr`, `twilio_inbound`, `twilio_outbound` |

## How to run a demo

```bash
cd python
uv run examples/voice/<demo_name>.py
```

Recording lands at `python/recordings/<demo_name>/full.wav` plus per-segment WAVs and a `manifest.json`. Open the WAV in any player. Skim the script + read the docstring at the top of the .py file — it tells you what the demo is *supposed* to prove.

## What "works" looks like

For each demo: **listen end-to-end** and answer:

1. **Does the agent respond to what the user actually said?** (Not a hallucinated turn, not a duplicate greeting.)
2. **Does the conversation feel like a real call?** (Pacing, latency, no awkward dead-air, no mid-word cuts.)
3. **Does the demo's specific point land?** (E.g. for `interruption_recovery` — did the user actually interrupt mid-sentence and did the agent recover?)
4. **Did `result.success` agree with your ears?** (If the judge said pass and it sounded broken, that's a bug. Or vice versa.)

## Demos to bash (OpenAI-only path — ready to run)

Group by interest. Each links to its file; the docstring at the top has the full "what this proves" + run instructions.

### Core voice loop
- **`basic_greeting`** — Pipecat + UserSim + Judge pipeline end-to-end. Smoke test. *(Drew already verified this one — start here to confirm your env works.)*
- **`voice_text_parity`** — same `scenario.run()` handles voice and text. Sanity check.
- **`recording_playback`** — `result.audio.save()` writes WAV + MP3; `audio_playback=True` streams live. Verify the saved files actually play.
- **`observability`** — `on_audio_chunk` / `on_voice_event` callbacks fire; `result.latency` populated.
- **`stt_swap`** — `scenario.configure(stt=...)` swaps OpenAI for ElevenLabs STT.

### Interruption + turn-taking (high-risk area)
- **`interruption_recovery`** — two forms: `agent(wait=False) + user(...)` vs sugar `scenario.interrupt(...)`. **Listen carefully** — the user should cut the agent mid-sentence, agent should recover.
- **`random_interruptions`** — `interrupt_probability=0.4` over 5 turns. Should hear ~2 interruptions.
- **`silence_handling`** — `scenario.silence(10.0)` should make the bot prompt the user.
- **`long_hold`** — `scenario.sleep(15)` — bot should fill with hold music / filler, not dead air.

### Difficult callers (judge-quality area)
- **`angry_customer`** — emotional caller + cafe noise + phone codec. Does the bot stay calm?
- **`emotional_escalation`** — persona escalates calm→frustrated. Does the bot detect the shift?
- **`accent_loop`** — heavy-accent voice spelling a name. Should offer alternative input after 2 fails.
- **`background_handoff`** — user says "hold on" + background noise. Bot should wait.
- **`multi_intent`** — single turn with two intents. Both should be addressed.

### Audio injection
- **`prerecorded_audio`** — `scenario.audio("file.wav")` injects a real WAV as the user's turn.
- **`tool_verification`** — plain Python callable in the script inspects `state.timeline` for tool calls mid-scenario.

### Realtime providers (OpenAI Realtime — unblocked, no extra creds)
- **`openai_realtime_agent`** — Realtime API as the *agent*.
- **`openai_realtime_user`** — Realtime API as the *user simulator* (natural prosody).
- **`pipecat_scenario`** — full Pipecat scenario.
- **`pipecat_ws`** — raw Pipecat WebSocket transport.

### Cred-blocked (skip unless you have keys)
- `elevenlabs_hosted`, `elevenlabs_branded`, `gemini_live`, `dtmf_ivr`, `twilio_inbound`, `twilio_outbound`

## How to file what you find

Comment on **PR [#355](https://github.com/langwatch/scenario/pull/355)** with this template:

```
Demo: <name>
Stack: <openai-only | elevenlabs | gemini | twilio>
Result: <result.success value>
Sounds right? <yes | no | partial>
What's wrong: <one sentence>
Recording: attach python/recordings/<name>/full.wav
Repro steps (if non-deterministic): <…>
```

For obvious bugs (crashes, tracebacks, hangs >30s) file a separate issue and link it back to #355.

## Known caveats (don't file these)

- `gemini_live` is blocked — current key has no `bidiGenerateContent` models.
- All Twilio demos are blocked on auth-token rotation (ND-15).
- 8 e2e demos are marked `@pytest.mark.skip` due to an asyncio-isolation suite-bug (they pass when run individually as scripts, hang when run as part of the full pytest suite). The standalone scripts are what we want bashed.

## Reference

- Issue: https://github.com/langwatch/scenario/issues/350
- PR: https://github.com/langwatch/scenario/pull/355
- Feature contract: `python/specs/voice-agents.feature` (102 scenarios)
- Each demo's docstring (top of `python/examples/voice/<name>.py`) is the source-of-truth for what it proves.
