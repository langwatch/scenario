"""
Example 6.5 — Tool call verification as a plain Python step.

What this demo proves:
    A plain Python callable can be inserted into script=[...] at any position,
    receives ScenarioState, and can inspect state.timeline for tool_call events
    mid-scenario — NOT just post-hoc. This is the Example 6.5 "callable as
    script step" pattern (proposal §6.5 L998-1028, AC: NOT OPTIONAL).

AC: specs/voice-agents.feature "Example 6.5 — tool call verification as a plain Python step"
    Source §6.5, L998-1028.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_example_6_5_tool_verification.py

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
from scenario.scenario_state import ScenarioState  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


def assert_tool_called(state: ScenarioState) -> None:
    """
    Plain Python callable script step.

    Inspects state.timeline for a tool_call event named 'get_customer_info'.
    Raises AssertionError if the event is absent — making this a mid-scenario
    assertion that fails the scenario immediately rather than surfacing only
    at judge time.
    """
    tool_events = [
        e
        for e in state.timeline  # type: ignore[attr-defined]
        if e.type == "tool_call" and e.name == "get_customer_info"
    ]
    assert len(tool_events) > 0, (
        "Expected tool_call 'get_customer_info' in timeline; "
        f"found: {[e.type for e in state.timeline]}"  # type: ignore[attr-defined]
    )
    print(f"[assert_tool_called] tool_call found: {tool_events[0]}")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="example_6_5_tool_verification",
        description=(
            "Customer asks for their account balance. The bot must call "
            "get_customer_info before answering. A plain Python callable "
            "asserts that mid-scenario."
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
                    "The agent called get_customer_info before answering",
                    "The agent provided the account balance clearly",
                ]
            ),
        ],
        script=[
            scenario.user("What's my account balance?"),
            scenario.agent(),
            assert_tool_called,  # plain Python callable — Example 6.5 pattern
            scenario.user("Thank you"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=6,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.timeline:
        print(f"timeline events: {[e.type for e in result.timeline]}")

    return result


if __name__ == "__main__":
    asyncio.run(main())
