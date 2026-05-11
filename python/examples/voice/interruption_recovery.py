"""
Example 6.2 — Interruption recovery.

What this demo proves:
    Two equivalent ways to express an interruption, both deterministic
    (no wall-clock sleeps):

      1. **Unrolled form**:  agent(wait=False) + user("...")
         The agent starts replying in the background; user() waits for
         the agent to actually start speaking, then interrupts.

      2. **Sugar**:  scenario.interrupt("...")
         Same thing, declarative.

    Both call into executor.user(), which on a pending agent task:
    waits for the agent to start producing audio (so we don't interrupt
    silence), fires the transport-native interrupt signal if the adapter
    supports it (Twilio ``clear``, OpenAI Realtime ``response.cancel``,
    etc.), then sends the replacement user turn. On adapters without
    a native interrupt, the user audio simply overlaps with the agent's
    TTS and the SUT's VAD detects barge-in.

    The judge sees the agent recover gracefully both times.

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
                        # Claim from docstring: two interrupt forms both fire transport-native barge-in.
                        "The agent's first reply was actually cut off by the user's interruption",
                        "The agent's second reply was actually cut off by the user's interruption",
                        "The conversation is a coherent example of the interruption-recovery flow",
                    ]
                ),
            ],
            script=[
                # Interrupt #1 — unrolled form. agent(wait=False) starts the
                # bot's reply in the background; user() waits for the bot to
                # actually start speaking, then interrupts.
                scenario.user("Tell me about my billing"),
                scenario.agent(wait=False),
                scenario.user("Wait sorry, I meant account support, not billing"),
                scenario.agent(),
                # Interrupt #2 — sugar. Identical behaviour, one step.
                scenario.user("Tell me about every product feature you offer"),
                scenario.interrupt("Sorry one more thing — what are your business hours?"),
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
