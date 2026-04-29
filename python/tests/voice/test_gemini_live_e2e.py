"""
E2E wrapper for Demo — Gemini Live native audio.

AC: a live session is established and result.success is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_gemini_live_e2e_success(requires_llm, requires_gemini_key, requires_transport_ready):
    """Gemini Live native-audio session runs; result.success is True."""
    from scenario.voice import GeminiLiveAgentAdapter
    adapter = GeminiLiveAgentAdapter()
    requires_transport_ready(adapter)

    from gemini_live import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
