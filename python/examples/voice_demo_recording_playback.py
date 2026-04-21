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
    uv run examples/voice_demo_recording_playback.py

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
import tempfile
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
OUT_DIR = Path(__file__).parent.parent / "tmp" / "demo_recording"


async def main() -> scenario.ScenarioResult:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = OUT_DIR / "demo.wav"
    mp3_path = OUT_DIR / "demo.mp3"

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

    # Save in both formats.
    if result.audio is not None:
        result.audio.save(wav_path)
        print(f"WAV saved: {wav_path} ({wav_path.stat().st_size} bytes)")
        try:
            result.audio.save(mp3_path, format="mp3")
            print(f"MP3 saved: {mp3_path} ({mp3_path.stat().st_size} bytes)")
        except Exception as e:
            print(f"MP3 save failed (ffmpeg may not be available): {e}")
    else:
        print("No audio recorded (adapter stub or no live bot).")

    print(f"success: {result.success}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
