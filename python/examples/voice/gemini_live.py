"""
Platform demo — Gemini Live native audio.

What this demo proves:
    GeminiLiveAgentAdapter establishes a real Gemini Live session with
    model="gemini-2.5-flash-native-audio-latest", exchanges native-audio turns, and
    result.success == True after a one-turn exchange.

AC: specs/voice-agents.feature "Demo — Gemini Live native audio"
    Source §5.6, L815-826.

How to run:
    cd python
    uv run examples/voice/gemini_live.py

Required env vars:
    GEMINI_API_KEY      — Gemini Live agent + judge LLM
    ELEVENLABS_API_KEY  — user simulator TTS voice (no OpenAI dep)
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

REQUIRED_ENV = ("GEMINI_API_KEY", "ELEVENLABS_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.config.voice_models import GEMINI_LIVE_MODEL  # noqa: E402

# Judge runs on Gemini — no OpenAI dependency in this demo.
scenario.configure(default_model="gemini/gemini-2.0-flash")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_gemini_live",
        description=(
            "Single-turn happy path against Gemini 2.5 Flash native-audio model. "
            "User says hello; Gemini responds; judge evaluates."
        ),
        agents=[
            scenario.GeminiLiveAgentAdapter(
                model=GEMINI_LIVE_MODEL,
                voice="Algieba",
                system_instruction="You are a helpful assistant. Keep responses brief.",
            ),
            # ElevenLabs voice "Sarah" — premade, available on free tier.
            scenario.UserSimulatorAgent(voice="elevenlabs/EXAVITQu4vr4xnSDxMaL"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent responded naturally to the greeting",
                    # Claim from docstring: Gemini Live native-audio session over real transport.
                    "The agent and user exchanged native-audio turns over a real Gemini Live session",
                    "The conversation is a coherent example of the Gemini Live native-audio path",
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
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
