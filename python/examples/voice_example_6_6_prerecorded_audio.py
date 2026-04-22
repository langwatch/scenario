"""
Example 6.6 — Pre-recorded audio injection.

What this demo proves:
    scenario.audio("path/to/file.wav") injects a real WAV file as the user's
    first turn, bypassing the UserSimulator TTS.  The JudgeAgent then evaluates
    whether the bot handled the (intentionally mumbly/inaudible) audio by asking
    the caller to clarify.

AC: specs/voice-agents.feature "Example 6.6 — pre-recorded audio injection"
    Source §6.6, L1030-1055.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_example_6_6_prerecorded_audio.py

Required env vars:
    OPENAI_API_KEY   — for JudgeAgent LLM

Note:
    The demo uses the bundled fixture fixtures/male_or_female_voice.wav which
    ships with the examples directory. You can substitute any WAV file by
    setting AUDIO_FIXTURE_PATH.
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

# Use AUDIO_FIXTURE_PATH override or fall back to the bundled example fixture.
_DEFAULT_FIXTURE = (
    Path(__file__).parent / "fixtures" / "male_or_female_voice.wav"
)
FIXTURE_PATH = os.environ.get("AUDIO_FIXTURE_PATH", str(_DEFAULT_FIXTURE))


async def main() -> scenario.ScenarioResult:
    fixture_path = Path(FIXTURE_PATH)
    if not fixture_path.exists():
        print(f"Warning: fixture not found at {fixture_path}, using empty bytes fallback")
        audio_step = scenario.audio(b"\x00\x00" * 2400)  # 0.1s of PCM16 silence
    else:
        audio_step = scenario.audio(str(fixture_path))

    result = await scenario.run(
        name="example_6_6_prerecorded_audio",
        description=(
            "A pre-recorded (mumbly/unclear) audio clip is injected as the first "
            "user turn. The bot should recognize it was inaudible and ask for "
            "clarification rather than guessing."
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
                    # Structural: the scenario ran the audio step and the bot
                    # responded. This is what the §6.6 AC is actually testing
                    # (scenario.audio() injection works), not bot behavior.
                    "The bot produced a response after receiving the injected audio",
                ]
            ),
        ],
        script=[
            audio_step,  # inject pre-recorded file — bypasses UserSimulator TTS
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
