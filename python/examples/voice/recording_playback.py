"""
Cross-cutting demo — Recording and playback.

What this demo proves:
    1. result.audio.save("demo.wav")  writes a WAV file with non-zero duration.
    2. result.audio.save("demo.mp3")  writes an MP3 via the bundled ffmpeg binary.
    3. audio_playback=True wires the live-stream playback path during the run.

    The ffmpeg subprocess is spawned by VoiceRecording.save() for the MP3 case;
    the platform audio driver is spawned by scenario.run() when audio_playback=True.
    Both files must exist with non-zero size after the demo finishes.

AC: specs/voice-agents.feature "Demo — recording and playback"

How to run:
    cd python
    uv run examples/voice/recording_playback.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM

Note:
    audio_playback=True tries to open a local audio device. On headless CI boxes
    ffmpeg will fail to open the device; the scenario continues gracefully
    (per §4.7 degradation guarantee). The WAV/MP3 files are still written.
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
            name="demo_recording_playback",
            description=(
                "Record a two-turn voice conversation and save it as WAV + MP3. "
                "audio_playback=True streams live to the local audio device."
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
                        "The agent responded helpfully",
                        # Claim from docstring: result.audio.save() writes WAV + MP3, audio_playback wires live playback.
                        "The agent and user produced enough audio that a non-empty recording can be saved",
                        "The conversation is a coherent example of the recording-and-playback flow",
                    ]
                ),
            ],
            script=[
                scenario.user("Hello"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=4,
            audio_playback=True,
        )

    print(f"success: {result.success}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
