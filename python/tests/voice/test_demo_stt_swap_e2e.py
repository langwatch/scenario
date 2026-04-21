"""
E2E wrapper for Demo — STT provider swap via scenario.configure.

AC: ElevenLabsSTTProvider.transcribe() is exercised (not the default OpenAI path);
result.success is True.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_stt_swap_e2e_success():
    """STT provider swap demo completes; result.success is True."""
    from voice_demo_stt_swap import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_stt_swap_elevenlabs_transcribe_called():
    """
    _InstrumentedSTT.transcribe() accumulator is non-empty after a live run.
    Skipped when no live bot (no audio turns → transcribe not called).
    """
    import voice_demo_stt_swap as demo  # type: ignore[import]

    # Reset accumulator before each test run.
    demo._transcribe_calls.clear()

    result = await demo.main()

    if result.audio is None:
        pytest.skip("No audio recorded (no live bot); STT transcribe not invoked")

    assert len(demo._transcribe_calls) > 0, (
        "Expected ElevenLabsSTTProvider.transcribe() to be called at least once"
    )
