"""
E2E wrapper for Demo — STT provider swap via scenario.configure.

AC: ElevenLabsSTTProvider.transcribe() is exercised (not the default OpenAI path);
result.success is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_stt_swap_e2e_success(requires_llm, requires_elevenlabs_key, requires_pipecat_bot):
    """STT provider swap demo completes; result.success is True."""
    from stt_swap import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_demo_stt_swap_elevenlabs_transcribe_called(requires_llm, requires_elevenlabs_key, requires_pipecat_bot):
    """
    _InstrumentedSTT.transcribe() accumulator is non-empty after a live run.
    Skipped when no live bot (no audio turns → transcribe not called).
    """
    import stt_swap as demo  # type: ignore[import]

    # Reset accumulator before each test run.
    demo._transcribe_calls.clear()

    result = await demo.main()

    if result.audio is None:
        pytest.skip("No audio recorded (no live bot); STT transcribe not invoked")

    assert len(demo._transcribe_calls) > 0, (
        "Expected ElevenLabsSTTProvider.transcribe() to be called at least once"
    )
