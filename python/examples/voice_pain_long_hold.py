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
    uv run examples/voice_pain_long_hold.py

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

REQUIRED_ENV = ("OPENAI_API_KEY",)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
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
                ]
            ),
        ],
        script=[
            scenario.user("What's my account balance?"),
            scenario.agent(),
            scenario.sleep(15),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=6,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
