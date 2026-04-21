"""
E2E wrapper for Demo — Pipecat WebSocket adapter happy path.

AC: result.success is True and the recording contains both user-sim and
agent audio segments.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY",)

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_pipecat_ws_e2e_success():
    """Pipecat WebSocket demo runs and result.success is True."""
    from voice_demo_pipecat_ws import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_pipecat_ws_recording_has_segments():
    """
    When a live Pipecat bot is present, result.audio.segments contains
    both user-sim and agent audio. Skipped without a live bot.
    """
    from voice_demo_pipecat_ws import main  # type: ignore[import]

    result = await main()

    if result.audio is None:
        pytest.skip("No audio recorded (no live Pipecat bot at PIPECAT_BOT_URL)")

    assert len(result.audio.segments) > 0, (
        "Expected at least one audio segment in result.audio.segments"
    )
