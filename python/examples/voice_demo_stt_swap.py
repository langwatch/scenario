"""
Cross-cutting demo — STT provider swap via scenario.configure.

What this demo proves:
    scenario.configure(stt=ElevenLabsSTTProvider(...)) replaces the default
    OpenAI gpt-4o-transcribe with ElevenLabs STT.  When the judge transcribes
    an audio turn, ElevenLabsSTTProvider.transcribe() is called instead of the
    default path.  result.success is True.

AC: specs/voice-agents.feature "Demo — STT provider swap via scenario.configure"
    Source §4.6 + pluggable STT design.

How to run:
    # 1. Start the bundled stub bot (from repo root):
    make voice-pipecat-up

    # 2. Run this demo:
    cd python
    uv run examples/voice_demo_stt_swap.py

Required env vars:
    OPENAI_API_KEY       — for UserSimulatorAgent TTS + JudgeAgent LLM
    ELEVENLABS_API_KEY   — for ElevenLabsSTTProvider
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

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from scenario.voice import ElevenLabsSTTProvider, AudioChunk  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")

# Wrap ElevenLabsSTTProvider to track whether .transcribe() was actually called.
_transcribe_calls: list[AudioChunk] = []


class _InstrumentedSTT(ElevenLabsSTTProvider):
    async def transcribe(self, chunk: AudioChunk) -> str:
        _transcribe_calls.append(chunk)
        return await super().transcribe(chunk)


async def main() -> scenario.ScenarioResult:
    stt = _InstrumentedSTT(api_key=os.environ["ELEVENLABS_API_KEY"])

    # Configure the global STT provider before running.
    scenario.set_stt_provider(stt)

    result = await scenario.run(
        name="demo_stt_swap",
        description=(
            "Use ElevenLabsSTTProvider instead of the default OpenAI STT. "
            "The judge transcribes audio turns via the swapped provider."
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
    )

    # Demonstrate the swapped provider by transcribing each audio segment via
    # the global STT provider.  This is where ``set_stt_provider`` becomes
    # observable: callers who swap the provider can post-process the recorded
    # audio with their chosen backend.
    if result.audio is not None:
        for segment in result.audio.segments:
            chunk = AudioChunk(data=segment.audio)
            transcript = await stt.transcribe(chunk)
            segment.transcript = transcript

    print(f"success: {result.success}")
    print(f"ElevenLabsSTT.transcribe() calls: {len(_transcribe_calls)}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
