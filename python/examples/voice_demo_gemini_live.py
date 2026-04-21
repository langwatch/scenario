"""
Platform demo — Gemini Live native audio.

What this demo proves:
    GeminiLiveAgentAdapter establishes a real Gemini Live session with
    model="gemini-2.5-flash-native-audio", exchanges native-audio turns, and
    result.success == True after a one-turn exchange.

AC: specs/voice-agents.feature "Demo — Gemini Live native audio"
    Source §5.6, L815-826.

How to run:
    cd python
    uv run examples/voice_demo_gemini_live.py

Required env vars:
    OPENAI_API_KEY   — for JudgeAgent LLM
    GEMINI_API_KEY   — for GeminiLiveAgentAdapter
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

REQUIRED_ENV = ("OPENAI_API_KEY", "GEMINI_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_gemini_live",
        description=(
            "Single-turn happy path against Gemini 2.5 Flash native-audio model. "
            "User says hello; Gemini responds; judge evaluates."
        ),
        agents=[
            scenario.GeminiLiveAgentAdapter(
                model="gemini-2.5-flash-native-audio",
                voice="Algieba",
                system_instruction="You are a helpful assistant. Keep responses brief.",
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent responded naturally to the greeting",
                ]
            ),
        ],
        script=[
            scenario.user("Hello, can you help me?"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
