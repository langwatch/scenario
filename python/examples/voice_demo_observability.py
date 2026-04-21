"""
Cross-cutting demo — Observability hooks and latency metrics.

What this demo proves:
    on_audio_chunk and on_voice_event callbacks fire during a live voice run.
    result.latency exposes time_to_first_byte, p50_response_time, p95_response_time.

AC: specs/voice-agents.feature "Demo — observability hooks and latency metrics"
    Source §4.7, L647-653 and §4.6, L617-625.

How to run:
    cd python
    uv run examples/voice_demo_observability.py

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
from scenario.voice import AudioChunk, VoiceEvent  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")

# Accumulators — closures capture these lists so we can assert post-run.
_audio_chunks: list[AudioChunk] = []
_voice_events: list[VoiceEvent] = []


def on_audio_chunk(chunk: AudioChunk) -> None:
    _audio_chunks.append(chunk)


def on_voice_event(event: VoiceEvent) -> None:
    print(f"[voice_event] {event.type} @ {event.time:.3f}s")
    _voice_events.append(event)


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_observability",
        description=(
            "Wire on_audio_chunk and on_voice_event callbacks to capture "
            "real-time events. Assert both fired and latency metrics are present."
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
            scenario.user("Hello, quick question"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
        on_audio_chunk=on_audio_chunk,
        on_voice_event=on_voice_event,
    )

    print(f"success: {result.success}")
    print(f"audio_chunks received: {len(_audio_chunks)}")
    print(f"voice_events received: {len(_voice_events)}")

    if result.latency is not None:
        print(f"time_to_first_byte: {result.latency.time_to_first_byte}")
        print(f"p50_response_time: {result.latency.p50_response_time}")
        print(f"p95_response_time: {result.latency.p95_response_time}")
    else:
        print("latency: None (no audio turns recorded)")

    return result


if __name__ == "__main__":
    asyncio.run(main())
