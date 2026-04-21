"""
E2E wrapper for Demo — Gemini Live native audio.

AC: a live session is established and result.success is True.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY", "GEMINI_API_KEY")

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_gemini_live_e2e_success():
    """Gemini Live native-audio session runs; result.success is True."""
    from voice_demo_gemini_live import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
