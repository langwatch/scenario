"""
Platform demo — Pipecat WebSocket adapter happy path.

What this demo proves:
    PipecatAgentAdapter (WebSocket transport) connects to a live Pipecat bot,
    runs a full scenario.run() with the voice UserSimulator and JudgeAgent, and
    produces a result with both user-sim and agent audio in result.audio.segments.

AC: specs/voice-agents.feature "Demo — Pipecat WebSocket adapter happy path"

How to run:
    # Terminal A — start the Pipecat bot
    cd python
    pip install "pipecat-ai[openai,websockets,runner]"
    python examples/voice_pipecat_twilio_bot.py --host 0.0.0.0 --port 8765

    # Terminal B — run this demo
    cd python
    uv run examples/voice_demo_pipecat_ws.py

Required env vars:
    OPENAI_API_KEY       — for UserSimulatorAgent TTS + JudgeAgent LLM

Optional env vars:
    PIPECAT_BOT_URL      — default: ws://localhost:8765/stream
"""

# Re-export from the original pipecat scenario so we stay DRY.
# The original demo is voice_pipecat_scenario.py; this module delegates to it.

import sys

from voice_pipecat_scenario import main  # type: ignore[import]

if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
