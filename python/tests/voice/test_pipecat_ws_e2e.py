"""
E2E wrapper for Demo — Pipecat WebSocket adapter happy path.

AC: result.success is True and the recording contains both user-sim and
agent audio segments.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_pipecat_ws_e2e(requires_llm, requires_pipecat_bot):
    """Single run covers both AC invariants:
    1. result.success True,
    2. result.audio.segments non-empty (user-sim + agent audio captured).

    Previously split; each test called main() independently — doubled
    LLM + bot cost. Consolidated.
    """
    from pipecat_ws import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
    assert result.audio is not None, (
        "Expected recorded audio with a live Pipecat bot — result.audio is None."
    )
    assert len(result.audio.segments) > 0, (
        "Expected at least one audio segment in result.audio.segments"
    )
