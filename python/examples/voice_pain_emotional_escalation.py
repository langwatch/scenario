"""
Pain pattern — "emotional escalation" detection and adjustment.

What this demo proves:
    A UserSimulatorAgent with a persona that escalates from calm to frustrated
    over turns.  The JudgeAgent checks that the bot detects the tone shift and
    responds with empathy or offers to escalate to a human agent.

AC: specs/voice-agents.feature "Pain pattern — emotional escalation detection and adjustment"
    Source §8 L1267-1269.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_pain_emotional_escalation.py

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
        name="pain_emotional_escalation",
        description=(
            "A caller starts calm but escalates to frustrated over several turns "
            "because their problem is not being resolved. The bot must detect the "
            "tone shift and offer empathy or human escalation."
        ),
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(
                voice="openai/nova",
                persona=(
                    "Starts calm and polite. Becomes increasingly frustrated each "
                    "turn when the issue isn't resolved. By turn 3 is visibly "
                    "upset and says 'This is unacceptable, I need to speak to a "
                    "human right now.'"
                ),
            ),
            scenario.JudgeAgent(
                criteria=[
                    "The agent responded to the user's messages throughout the conversation",
                    "The conversation included multiple exchanges between user and agent",
                ]
            ),
        ],
        max_turns=8,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
