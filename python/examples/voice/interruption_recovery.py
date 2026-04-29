"""
Example 6.2 — Interruption recovery.

What this demo proves:
    Two equivalent ways to interrupt the agent mid-utterance, run in
    sequence within one scenario:

      1. The unrolled form from spec §6.2 / Example 6.2:
         agent(wait=False) + sleep(N) + user("...")
      2. The declarative sugar from spec §4.4:
         scenario.interrupt(after=N, content="...")

    Both push user audio onto the wire while the agent is still TTS-ing;
    the bot's VAD detects the new speech and cancels its in-flight TTS
    (barge-in). The judge sees the agent recover gracefully both times.

AC: specs/voice-agents.feature "Example 6.2 — interruption recovery"
    Source §6.2, L901-929; §4.4 L450-467.

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
                "User interrupts the agent twice mid-utterance — first via the "
                "unrolled agent(wait=False)+sleep+user composition, then via "
                "the scenario.interrupt() sugar. Judge: bot recovered both times."
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
                        "The agent recovered gracefully from BOTH interruptions",
                        "The agent addressed account support after the first interrupt",
                        "The agent addressed business hours after the second interrupt",
                    ]
                ),
            ],
            script=[
                # ------------------------------------------------------------------
                # Interrupt #1 — unrolled form (spec §6.2 / Example 6.2 verbatim).
                # A wordy first user turn elicits a long bot reply so the bot
                # is still mid-TTS at the 1.5s interrupt mark.
                # ------------------------------------------------------------------
                scenario.user(
                    "Walk me through my entire billing history from the past year, "
                    "including every charge with date, amount, and category, and "
                    "explain how each one was calculated."
                ),
                scenario.agent(wait=False),
                scenario.sleep(1.5),
                scenario.user("Wait sorry, I meant account support, not billing"),
                scenario.agent(),
                # ------------------------------------------------------------------
                # Interrupt #2 — scenario.interrupt() sugar (spec §4.4).
                # Same wire behaviour, one declarative step.
                # ------------------------------------------------------------------
                scenario.user(
                    "Actually, can you also tell me about every product feature "
                    "you offer in great detail, top to bottom, the full catalogue."
                ),
                scenario.interrupt(
                    after=1.5,
                    content="Sorry one more thing — what are your business hours?",
                ),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=10,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.latency is not None:
        print(f"interrupt_response_time: {result.latency.interrupt_response_time}")

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
