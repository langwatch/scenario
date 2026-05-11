"""
Example 6.8 — Silence handling.

What this demo proves:
    scenario.silence(10.0) sends 10 seconds of PCM16 zero-audio to the agent.
    A well-implemented bot should detect the silence and prompt the caller to
    speak. The JudgeAgent evaluates whether the bot prompted during the silence.

AC: specs/voice-agents.feature "Example 6.8 — silence handling"
    Source §6.8, L1087-1113.

How to run:
    cd python
    uv run examples/voice/silence_handling.py

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
            name="example_6_8_silence_handling",
            description=(
                "After an initial question, 10 seconds of silence is injected. "
                "The bot should prompt the caller during the silence. "
                "The caller then speaks again and the bot closes out the call."
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
                        "The agent prompted the caller during the silence",
                        "The agent handled the silence gracefully without hanging up",
                        # Claim from docstring: scenario.silence(10.0) injects 10s of zero-audio.
                        "10 seconds of silence were delivered to the agent during the script",
                        "The conversation is a coherent example of the silence-handling flow",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user replies to the
            # greeting, then goes silent — testing how the agent handles a long
            # pause without user input.
            script=[
                scenario.agent(),
                scenario.user("Hello"),
                scenario.silence(10.0),
                scenario.agent(),
                scenario.user("Sorry, I'm still here"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=8,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
