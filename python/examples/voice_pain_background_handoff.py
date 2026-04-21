"""
Pain pattern — "background handoff" should not trigger agent response.

What this demo proves:
    The user says "hold on" (a handoff signal) then background noise is layered
    onto the audio via audio_effects — simulating an overheard side conversation.
    The JudgeAgent checks that the agent waited rather than responding to the
    background audio as if it were user speech.

AC: specs/voice-agents.feature "Pain pattern — background handoff should not trigger agent response"
    Source §8 L1263-1265.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_pain_background_handoff.py

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

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    # The user hands off (away from mic), then a background conversation is
    # audible.  We simulate this by using background_noise on the next user turn,
    # keeping the user's scripted audio low-volume so the background is dominant.
    result = await scenario.run(
        name="pain_background_handoff",
        description=(
            "The caller says 'hold on' and moves away from the mic. An overheard "
            "side conversation plays as background. The bot should wait patiently "
            "rather than respond to the background audio."
        ),
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(
                voice="openai/nova",
                # background_noise simulates overheard conversation audio layered on top.
                audio_effects=[
                    scenario.effects.background_noise("cafe", 0.5),
                ],
            ),
            scenario.JudgeAgent(
                criteria=[
                    "The agent waited for the caller to return rather than responding "
                    "to the background noise",
                    "The agent did not treat the background conversation as user speech",
                ]
            ),
        ],
        script=[
            scenario.user("hold on"),
            # Silence simulates the user moving away from the mic
            scenario.silence(5.0),
            scenario.agent(),
            scenario.user("Sorry I'm back"),
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
