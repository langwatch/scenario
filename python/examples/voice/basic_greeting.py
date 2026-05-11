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
    uv run examples/voice/basic_greeting.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM

Note:
    Set PIPECAT_BOT_URL if your bot is at a non-default URL.  The e2e
    test skips when OPENAI_API_KEY is absent.
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
                        # Claim from docstring: end-to-end voice pipeline.
                        "The agent and user exchanged real audio turns",
                        "The conversation is a coherent example of a basic greeting flow",
                    ]
                ),
            ],
            script=[
                scenario.agent(),
                scenario.user("Hi, I need some help ordering pizza"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=4,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
