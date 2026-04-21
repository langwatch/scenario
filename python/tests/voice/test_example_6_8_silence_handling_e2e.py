"""
E2E wrapper for Example 6.8 — silence handling.

AC: agent prompts during 10s silence and result.success is True.
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
async def test_example_6_8_silence_handling_e2e_success():
    """Silence injection scenario completes with result.success True."""
    from voice_example_6_8_silence_handling import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
