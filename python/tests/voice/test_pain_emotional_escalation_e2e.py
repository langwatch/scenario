"""
E2E wrapper for pain pattern — "emotional escalation" detection and adjustment.

AC: judge checks the agent detects the tone shift and offers empathy or
human escalation.
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
async def test_pain_emotional_escalation_e2e_success():
    """Agent detects emotional escalation and responds with empathy."""
    from voice_pain_emotional_escalation import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
