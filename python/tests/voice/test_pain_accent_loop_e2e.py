"""
E2E wrapper for pain pattern — "accent misunderstanding" loop escape.

AC: judge checks the agent offers an alternative input method after 2 failed
attempts and does not repeat the same question more than 3 times.
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
async def test_pain_accent_loop_e2e_success():
    """Agent offers alternative input after repeated accent misunderstandings."""
    from voice_pain_accent_loop import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
