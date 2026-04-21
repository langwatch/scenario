# voice_pipecat_bot

Minimal WebSocket stub bot used by the `@e2e` voice demos.

## What it does

Implements the Twilio Media Streams wire protocol that `PipecatAgentAdapter`
expects — without depending on `pipecat-ai`:

1. Accepts a WebSocket connection on `ws://localhost:8765/stream`
2. Handles the `connected` / `start` / `media` / `stop` / `dtmf` event sequence
3. Uses OpenAI chat API (`gpt-4o-mini`) for LLM responses
4. Uses OpenAI TTS (`tts-1 / alloy`) to synthesise speech
5. Uses OpenAI Whisper (`whisper-1`) to transcribe incoming audio
6. Streams reply audio back as base64-encoded µ-law 8 kHz `media` frames

All audio conversion (PCM16 24 kHz ↔ µ-law 8 kHz) is done with stdlib
`audioop` — no extra audio deps beyond what `scenario` already requires.

## Running

```bash
# From the repo root:
make voice-pipecat-up        # starts bot in background on :8765

# Or directly from python/:
uv run python examples/voice_pipecat_bot/bot.py

# With explicit host/port:
BOT_HOST=0.0.0.0 BOT_PORT=9000 uv run python examples/voice_pipecat_bot/bot.py
```

Stop it:

```bash
make voice-pipecat-down
```

## Environment variables

| Variable        | Default     | Purpose                          |
| --------------- | ----------- | -------------------------------- |
| `OPENAI_API_KEY`| —           | **Required** for LLM + TTS + STT |
| `BOT_HOST`      | `127.0.0.1` | Bind host                        |
| `BOT_PORT`      | `8765`      | Bind port                        |
| `BOT_LOG_LEVEL` | `INFO`      | Python logging level             |

Without `OPENAI_API_KEY` the bot falls back to canned replies and silent TTS
so the wire protocol is exercised, but judge criteria will likely fail.

## Demos that depend on this bot

All Pipecat-dependent `@e2e` demos use `PIPECAT_BOT_URL` (default:
`ws://localhost:8765/stream`):

- `voice_example_6_1_basic_greeting.py`
- `voice_example_6_2_interruption_recovery.py`
- `voice_example_6_3_angry_customer.py`
- `voice_example_6_5_tool_verification.py`
- `voice_example_6_6_prerecorded_audio.py`
- `voice_example_6_7_random_interruptions.py`
- `voice_example_6_8_silence_handling.py`
- `voice_pain_long_hold.py`
- `voice_pain_accent_loop.py`
- `voice_pain_multi_intent.py`
- `voice_pain_background_handoff.py`
- `voice_pain_emotional_escalation.py`
- `voice_demo_pipecat_ws.py` (re-exports `voice_pipecat_scenario.py`)
- `voice_demo_recording_playback.py`
- `voice_demo_observability.py`
- `voice_demo_stt_swap.py`
- `voice_demo_voice_text_parity.py`
- `voice_demo_openai_realtime_user.py`

## Implementation choice: stub bot (not pipecat-ai)

`pipecat-ai` is a ~multi-hundred-MB transitive dependency tree. Since the
adapter only needs the wire protocol (JSON Twilio Media Streams), this bot
implements that directly with `websockets` + `openai` + stdlib `audioop`.
The bot is a dev/demo artifact — not a production service.
