"""
Example 6.3 — Angry customer in noisy cafe.

What this demo proves:
    UserSimulatorAgent(voice="elevenlabs/rachel", persona=..., audio_effects=[...])
    delivers a difficult real-world test: an emotionally heightened caller with
    background cafe noise and phone codec quality degradation.
    The JudgeAgent evaluates empathy, noise-robustness, and resolution.

AC: specs/voice-agents.feature "Example 6.3 — angry customer in noisy cafe"
    Source §6.3, L931-967 and §8 emotional escalation.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_example_6_3_angry_customer.py

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
from _voice_recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="example_6_3_angry_customer",
        description=(
            "An angry customer calls from a noisy cafe about a wrong charge. "
            "The bot must handle the emotional tone and background noise, "
            "demonstrate empathy, and reach a resolution."
        ),
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(
                voice="openai/nova",
                persona=(
                    "Very angry customer who was charged incorrectly. "
                    "Speaking loudly and impatiently from a cafe. "
                    "Wants this fixed immediately."
                ),
                audio_effects=[
                    scenario.effects.background_noise("cafe", 0.4),
                    scenario.effects.phone_quality(),
                ],
            ),
            scenario.JudgeAgent(
                criteria=[
                    "The agent demonstrated empathy toward the angry customer",
                    "The agent maintained composure despite background noise",
                    "The agent offered a concrete resolution or next step",
                ]
            ),
        ],
        max_turns=6,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None), "example_6_3_angry_customer")
    return result


if __name__ == "__main__":
    asyncio.run(main())
