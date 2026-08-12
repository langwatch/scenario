"""
Cross-cutting demo — STT provider swap via scenario.set_stt_provider.

What this demo proves:
    scenario.set_stt_provider(ElevenLabsSTTProvider(...)) replaces the default
    OpenAI gpt-4o-transcribe with ElevenLabs STT.  When the judge transcribes
    an audio turn, ElevenLabsSTTProvider.transcribe() is called instead of the
    default path.  result.success is True.

AC: specs/voice-agents.feature
    "Python swaps STT providers via scenario.set_stt_provider"
    Source §4.6 + pluggable STT design.

How to run:
    cd python
    uv run examples/voice/stt_swap.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

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

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — examples still run with env already exported.
    pass

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.voice import (  # noqa: E402
    AudioChunk,
    ElevenLabsSTTProvider,
    get_stt_provider,
)

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")

# Wrap ElevenLabsSTTProvider to track whether .transcribe() was actually called.
_transcribe_calls: list[AudioChunk] = []


class _InstrumentedSTT(ElevenLabsSTTProvider):
    async def transcribe(self, audio: AudioChunk) -> str:
        _transcribe_calls.append(audio)
        return await super().transcribe(audio)


async def main() -> scenario.ScenarioResult:
    stt = _InstrumentedSTT(api_key=os.environ["ELEVENLABS_API_KEY"])

    # Install the process-wide STT provider before running. This is the only
    # Python entry point for swapping STT.
    scenario.set_stt_provider(stt)

    async with ensure_pipecat_bot():
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
                        # The judge only sees the transcript; it cannot
                        # observe which STT provider produced any text.
                        # These criteria check what IS verifiable from the
                        # transcript. The STT provider swap itself is
                        # verified *mechanically* below by counting
                        # ElevenLabsSTTProvider.transcribe() calls.
                        "The agent responded helpfully",
                        "The conversation is a coherent example of a voice exchange",
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

    # Snapshot before any post-run work, so the success criterion below counts
    # only the calls the run itself made.
    run_transcribe_count = len(_transcribe_calls)

    # Demonstrate the swapped provider by transcribing each audio segment
    # through the process-wide lookup.  Going via ``get_stt_provider()`` rather
    # than the local ``stt`` handle is what makes the swap observable: the
    # identity check proves the install took effect rather than the script
    # merely holding a reference.
    installed = get_stt_provider()
    assert installed is stt, (
        "set_stt_provider did not install the demo provider; "
        f"the process-wide provider is {type(installed).__name__}"
    )
    if result.audio is not None:
        for segment in result.audio.segments:
            chunk = AudioChunk(data=segment.audio)
            # ElevenLabs STT rejects <500ms clips with audio_too_short.  Skip
            # those; the demo's point is "the swapped provider was called,"
            # and we still exercise it on segments long enough to transcribe.
            if chunk.duration_seconds < 0.5:
                continue
            transcript = await installed.transcribe(chunk)
            segment.transcript = transcript

    # Mechanical proof of the swap: the run itself called
    # ElevenLabsSTTProvider.transcribe(). The judge cannot observe provider
    # internals from the transcript, so this is what verifies the docstring
    # claim. Only the pre-snapshot count qualifies; the post-run loop above
    # calls the provider too and must not be able to satisfy the criterion.
    swap_verified = run_transcribe_count > 0

    print(f"success: {result.success}")
    print(f"ElevenLabsSTT.transcribe() calls during the run: {run_transcribe_count}")
    print(f"ElevenLabsSTT.transcribe() calls in total: {len(_transcribe_calls)}")
    print(f"swap verified (run transcribe count > 0): {swap_verified}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))

    if not swap_verified:
        # If the swap didn't fire, demo failed regardless of judge verdict.
        result.success = False
        result.reasoning = (
            "STT provider swap NOT verified: the run never called "
            "ElevenLabsSTTProvider.transcribe(). The installed provider failed "
            f"to engage. (Original judge verdict: {result.reasoning})"
        )

    return result


if __name__ == "__main__":
    asyncio.run(main())
