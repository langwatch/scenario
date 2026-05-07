"""
Platform demo — Pipecat WebSocket adapter happy path.

What this demo proves:
    PipecatAgentAdapter (WebSocket transport) connects to a live Pipecat bot,
    runs a full scenario.run() with the voice UserSimulator and JudgeAgent, and
    produces a result with both user-sim and agent audio in result.audio.segments.

AC: specs/voice-agents.feature "Demo — Pipecat WebSocket adapter happy path"

How to run:
    cd python
    uv run examples/voice/pipecat_ws.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

    # Alternative: use the full pipecat-ai bot instead of the stub:
    #   pip install "pipecat-ai[openai,websockets,runner]"
    #   python examples/voice/_pipecat_twilio_bot.py --host 0.0.0.0 --port 8765

Required env vars:
    OPENAI_API_KEY       — for UserSimulatorAgent TTS + JudgeAgent LLM

Optional env vars:
    PIPECAT_BOT_URL      — default: ws://localhost:8765/stream
"""

# Re-export from the original pipecat scenario so we stay DRY.
# The original demo is voice/pipecat_scenario.py; this module delegates to it
# but passes its own demo_name so recordings land in recordings/pipecat_ws/
# instead of clobbering recordings/pipecat_scenario/.

from pipecat_scenario import main as _delegate_main  # type: ignore[import]


async def main():
    return await _delegate_main(demo_name="pipecat_ws")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
