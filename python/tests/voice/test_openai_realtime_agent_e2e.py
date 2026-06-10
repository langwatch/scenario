"""
E2E check — OpenAI Realtime adapter (AGENT role) against the GA Realtime API.

Integration / nightly, key-gated (``requires_llm``).  Runs the
``openai_realtime_agent`` demo script end-to-end against the real OpenAI
Realtime WebSocket API and asserts ``result.success`` is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_openai_realtime_agent_e2e_success(requires_llm):
    """OpenAI Realtime adapter (AGENT role) runs; result.success is True."""
    from openai_realtime_agent import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
