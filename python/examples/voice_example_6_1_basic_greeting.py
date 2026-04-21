"""
Example 6.1 — Basic greeting flow.

What this demo proves:
    The standard PipecatAgentAdapter + voice UserSimulator + JudgeAgent
    pipeline works end-to-end: connect, exchange audio turns, evaluate,
    record. result.audio.save() writes a real WAV file.

AC: specs/voice-agents.feature "Example 6.1 — basic greeting flow"
    Source §6.1, L874-899.

How to run:
    cd python
    uv run examples/voice_example_6_1_basic_greeting.py

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM

Note:
    This demo uses PipecatAgentAdapter pointing at a local mock bot URL.
    Without a live Pipecat bot the adapter will fail to connect; the demo
    will exit with an error message.  Set PIPECAT_BOT_URL if your bot is
    at a non-default URL.  The e2e test skips when OPENAI_API_KEY is absent.
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
OUTPUT_WAV = Path(__file__).parent.parent / "tmp" / "example_6_1_greeting.wav"


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="example_6_1_basic_greeting",
        description=(
            "A caller rings the bot. The bot greets them; the caller "
            "says 'Hi, I need some help'; the bot responds. "
            "Judge: bot greeted naturally and provided a helpful response."
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
                    "The agent greeted the user naturally",
                    "The agent offered help in a friendly tone",
                ]
            ),
        ],
        script=[
            scenario.agent(),
            scenario.user("Hi, I need some help"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.audio is not None:
        OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)
        saved = result.audio.save(OUTPUT_WAV)
        print(f"audio saved: {saved}")

    return result


if __name__ == "__main__":
    asyncio.run(main())
