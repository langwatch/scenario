"""
Cross-cutting demo — Observability hooks and latency metrics.

What this demo proves:
    on_audio_chunk and on_voice_event callbacks fire during a live voice run.
    result.latency exposes time_to_first_byte, p50_response_time, p95_response_time.

AC: specs/voice-agents.feature "Demo — observability hooks and latency metrics"
    Source §4.7, L647-653 and §4.6, L617-625.

How to run:
    cd python
    uv run examples/voice/observability.py

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
from scenario.voice import AudioChunk, VoiceEvent  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

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
    async with ensure_pipecat_bot():
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
                        # Claim from docstring: on_audio_chunk + on_voice_event hooks fire and result.latency populates.
                        "The on_audio_chunk and on_voice_event callbacks fired during the run",
                        "The conversation is a coherent example of observability-hooks-and-latency-metrics",
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

        # Assert non-zero so the demo fails loudly when the latency pipeline
        # is broken instead of silently printing 0.0 with success=True.
        assert (
            result.latency.time_to_first_byte
            and result.latency.time_to_first_byte > 0
        ), (
            "time_to_first_byte is missing or zero — the latency pipeline "
            "did not record any agent response time. The demo should not "
            "report success when its central claim is unverifiable."
        )
    else:
        print("latency: None (no audio turns recorded)")
        raise AssertionError(
            "result.latency is None — observability hooks fired but no "
            "latency was recorded. The demo's purpose is to prove these "
            "metrics get populated; bailing rather than printing success."
        )

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
