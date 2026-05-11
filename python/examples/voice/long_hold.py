"""
Pain pattern — "long hold" feedback during 15-second tool call.

What this demo proves:
    scenario.sleep(15) pauses the script for 15 seconds while the agent (IVR)
    is expected to play hold music / filler audio.  The JudgeAgent checks that
    the agent provided audio feedback during the wait rather than dead air.

AC: specs/voice-agents.feature "Pain pattern — long hold feedback during 15s tool call"
    Source §8 L1231-1241.

How to run:
    cd python
    uv run examples/voice/long_hold.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — examples still run with env already exported.
    pass

REQUIRED_ENV = ("OPENAI_API_KEY",)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="pain_long_hold",
            description=(
                "Caller asks for their account balance. The bot fetches it (15s "
                "simulated delay via sleep). The bot must not stay silent — it "
                "should play hold music or verbal acknowledgement."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "Agent provides audio feedback while waiting (hold music or verbal)",
                        "Agent does not leave the caller in dead silence for the full 15s",
                        # Claim from docstring: scenario.sleep(15) pauses the script while agent fills the wait.
                        "The script paused for 15 seconds during which the agent owned the floor",
                        "The conversation is a coherent example of the long-hold-with-feedback pain pattern",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user's question is
            # turn 2, in response to the greeting.
            script=[
                scenario.agent(),
                scenario.user("What's my account balance?"),
                scenario.agent(),
                scenario.sleep(15),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=8,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
