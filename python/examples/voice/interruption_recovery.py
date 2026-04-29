"""
Example 6.2 — Interruption recovery.

What this demo proves:
    scenario.agent(wait=False) + scenario.sleep(N) + scenario.user("...") compose
    correctly to simulate a mid-speech interruption.  The adapter accepts the
    interrupt audio and result.latency.interrupt_response_time is populated.

AC: specs/voice-agents.feature "Example 6.2 — interruption recovery"
    Source §6.2, L901-929.

How to run:
    cd python
    uv run examples/voice/interruption_recovery.py

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

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="example_6_2_interruption_recovery",
            description=(
                "User asks about billing; the bot starts answering. "
                "After 2 seconds the user interrupts with a correction. "
                "Judge: bot recovered gracefully and addressed the updated topic."
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
                        "The agent recovered gracefully after the interruption",
                        "The agent addressed the corrected topic (account support, not billing)",
                    ]
                ),
            ],
            script=[
                # A wordy first user turn elicits a long bot reply, which
                # makes the bot still be mid-TTS at the interrupt mark.
                scenario.user(
                    "Walk me through my entire billing history from the past year, "
                    "including every charge with date, amount, and category, and "
                    "explain how each one was calculated."
                ),
                # interrupt() = agent(wait=False) + sleep(after) + user(content)
                # in one step. The agent starts replying, 1.5s later the user
                # cuts in mid-sentence; the bot's VAD detects the new speech
                # and cancels its in-flight TTS — that's barge-in.
                scenario.interrupt(
                    after=1.5,
                    content="Wait sorry, I meant account support, not billing",
                ),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=6,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.latency is not None:
        print(f"interrupt_response_time: {result.latency.interrupt_response_time}")

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
