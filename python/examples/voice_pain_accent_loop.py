"""
Pain pattern — "accent misunderstanding" loop escape.

What this demo proves:
    A user simulator with a heavy-accent voice (elevenlabs/raj_indian_english)
    spells their name repeatedly.  The JudgeAgent checks that the bot offers
    an alternative input method after 2 failed attempts and does NOT repeat
    the same question more than 3 times.

AC: specs/voice-agents.feature "Pain pattern — accent misunderstanding loop escape"
    Source §8 L1243-1257.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_pain_accent_loop.py

Required env vars:
    OPENAI_API_KEY       — for JudgeAgent LLM
    ELEVENLABS_API_KEY   — for elevenlabs/raj_indian_english TTS voice
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

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")


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
        name="pain_accent_loop",
        description=(
            "A caller with a heavy Indian-English accent spells their name: "
            "R-A-J-E-S-H. The bot keeps misunderstanding and asking again. "
            "After 2 failures the bot should offer to send an SMS link instead."
        ),
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(
                voice="elevenlabs/raj_indian_english",
                persona=(
                    "Caller with a heavy Indian-English accent trying to spell "
                    "their last name 'Rajesh'. Gets increasingly frustrated when "
                    "the bot keeps asking them to repeat."
                ),
            ),
            scenario.JudgeAgent(
                criteria=[
                    "The agent offered an alternative input method (SMS, keypad, etc.) "
                    "after 2 failed spelling attempts",
                    "The agent did not repeat the same 'please spell your name' "
                    "question more than 3 times",
                ]
            ),
        ],
        script=[
            scenario.user("My last name is Rajesh — R, A, J, E, S, H"),
            scenario.agent(),
            scenario.user("R-A-J-E-S-H. Rajesh"),
            scenario.agent(),
            scenario.user("It's Rajesh! R as in Romeo, A as in Alpha, J as in Juliet"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=8,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
