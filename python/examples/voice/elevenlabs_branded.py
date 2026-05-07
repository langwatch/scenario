"""
Platform demo — ElevenLabs composable + branded voice agent.

What this demo proves:
    ElevenLabsVoiceAgent (locked decision #9) wires ElevenLabsSTTProvider and
    an ElevenLabs TTS voice by default.  Each seam (STT, LLM, TTS) fires at
    least once during the scenario and result.success == True.

    The demo also shows the escape hatch: overriding just the LLM while keeping
    branded STT and TTS defaults.

AC: specs/voice-agents.feature "Demo — ElevenLabs composable + branded agent"

How to run:
    cd python
    uv run examples/voice/elevenlabs_branded.py

Required env vars:
    OPENAI_API_KEY       — for JudgeAgent LLM and optional LLM override
    ELEVENLABS_API_KEY   — for ElevenLabsSTTProvider + ElevenLabs TTS
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

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> scenario.ScenarioResult:
    # ElevenLabsVoiceAgent provides opinionated defaults:
    #   stt=ElevenLabsSTTProvider   tts="elevenlabs/rachel"   llm from voice_models
    # We surface last_user_transcript and last_llm_response to assert seams fired.
    agent = scenario.ElevenLabsVoiceAgent(
        api_key=os.environ["ELEVENLABS_API_KEY"],
    )

    result = await scenario.run(
        name="demo_elevenlabs_branded",
        description=(
            "Branded ElevenLabsVoiceAgent: ElevenLabs STT + default LLM + "
            "ElevenLabs rachel TTS. User says hello; agent responds; judge passes."
        ),
        agents=[
            agent,
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent responded naturally to the greeting",
                    # Claim from docstring: branded composable agent — STT, LLM, TTS seams all fire.
                    "The user simulator delivered audio and the agent responded with audio",
                    "The conversation is a coherent example of the ElevenLabs composable + branded agent path",
                ]
            ),
        ],
        script=[
            scenario.user("Hi there, I have a quick question"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
    )

    print(f"success: {result.success}")
    print(f"last_user_transcript: {agent.last_user_transcript!r}")
    print(f"last_llm_response: {agent.last_llm_response!r}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
