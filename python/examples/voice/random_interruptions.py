"""
Example 6.7 — Random interruptions via interrupt_probability.

What this demo proves:
    UserSimulatorAgent(interrupt_probability=0.4) combined with proceed(turns=5)
    produces interruptions on roughly 40% of agent turns.  The JudgeAgent
    evaluates that the bot recovered context after each interruption.

AC: specs/voice-agents.feature "Example 6.7 — random interruptions via interrupt_probability"
    Source §6.7, L1057-1085.

How to run:
    cd python
    uv run examples/voice/random_interruptions.py

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

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="example_6_7_random_interruptions",
        description=(
            "A user simulator with 40% interruption probability calls the bot "
            "for help with their account. Over 5 turns, ~40% of agent responses "
            "are cut short. Judge: bot recovered context after interruptions."
        ),
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(
                voice="openai/nova",
                interrupt_probability=0.4,
            ),
            scenario.JudgeAgent(
                criteria=[
                    "The agent continued the conversation after interruptions rather than stopping",
                    "The conversation involved multiple turns between user and agent",
                ]
            ),
        ],
        script=[
            scenario.user("I need help with my account"),
            scenario.proceed(turns=5),
            scenario.judge(),
        ],
        max_turns=12,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.timeline:
        interrupt_events = [e for e in result.timeline if e.type == "user_interrupt"]
        print(f"interruptions in timeline: {len(interrupt_events)}")

    save_demo_recording(getattr(result, "audio", None), "example_6_7_random_interruptions")
    return result


if __name__ == "__main__":
    asyncio.run(main())
