"""
E2E wrapper for Demo — Gemini Live interruption flow.

AC: result.success is True after the user barge-in interrupts the agent
mid-turn and the conversation recovers.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_gemini_live_interruption_e2e_success(
    requires_llm, requires_gemini_key
):
    """Gemini Live adapter handles a user interruption and result.success is True."""
    from gemini_live_interruption import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
