"""
E2E wrapper for Demo — ElevenLabs hosted Conversational AI.

AC: the WS reaches wss://api.elevenlabs.io/v1/convai/conversation and
result.success is True after one turn.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID")

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_elevenlabs_hosted_e2e_success():
    """ElevenLabs hosted agent responds and result.success is True."""
    from voice_demo_elevenlabs_hosted import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
