"""
E2E wrapper for Demo — ElevenLabs hosted Conversational AI.

AC: the WS reaches wss://api.elevenlabs.io/v1/convai/conversation and
result.success is True after one turn.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_elevenlabs_hosted_e2e_success(requires_llm, requires_elevenlabs_hosted_agent):
    """ElevenLabs hosted agent responds and result.success is True."""
    from elevenlabs_hosted import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
