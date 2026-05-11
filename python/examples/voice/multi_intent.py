"""
Pain pattern — "multi-intent" single turn.

What this demo proves:
    A single user turn containing two distinct intents ("Cancel my subscription
    AND check my credits") arrives at the agent intact — no splitting.  The
    JudgeAgent checks that both intents are addressed in the agent's response.

AC: specs/voice-agents.feature "Pain pattern — multi-intent single turn"
    Source §8 L1259-1261.

How to run:
    cd python
    uv run examples/voice/multi_intent.py

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

MULTI_INTENT_UTTERANCE = (
    "Cancel my subscription and also check if I have any credits left"
)


async def main() -> scenario.ScenarioResult:
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="pain_multi_intent",
            description=(
                "A single user turn contains two intents: cancel subscription AND "
                "check remaining credits. The agent must address both."
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
                        "The agent produced a response after the user's message",
                        # Claim from docstring: a single user turn carrying TWO distinct intents arrives intact.
                        "The user's single turn contained two distinct intents and arrived as one turn",
                        "The agent's response addressed both intents (cancellation AND credits)",
                        "The conversation is a coherent example of the multi-intent-single-turn pain pattern",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user's compound
            # request is turn 2, in response to the greeting.
            script=[
                scenario.agent(),
                scenario.user(MULTI_INTENT_UTTERANCE),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=6,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
