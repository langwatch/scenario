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
    cd python
    uv run examples/voice/background_handoff.py

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
    # The user hands off (away from mic), then a background conversation is
    # audible.  We simulate this by using background_noise on the next user turn,
    # keeping the user's scripted audio low-volume so the background is dominant.
    async with ensure_pipecat_bot():
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
                        "The agent waited for the caller to return rather than responding to the background noise",
                        "The agent did not treat the background conversation as user speech",
                        # Claim from docstring: handoff signal then layered background audio.
                        "The script delivered the handoff signal followed by background-noise-overlaid audio",
                        "The conversation is a coherent example of ignoring audio not directed at the agent",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user replies in turn
            # 2 — here, with a "hold on" handoff signal — and the agent should
            # then wait quietly during the layered background audio.
            script=[
                scenario.agent(),
                scenario.user("hold on"),
                # Silence simulates the user moving away from the mic
                scenario.silence(5.0),
                scenario.agent(),
                scenario.user("Sorry I'm back"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=10,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
