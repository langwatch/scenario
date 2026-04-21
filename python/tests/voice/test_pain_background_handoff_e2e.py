"""
E2E wrapper for pain pattern — "background handoff" should not trigger
agent response.

AC: judge checks the agent waits rather than responding to background audio.
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
async def test_pain_background_handoff_e2e_success():
    """Agent waits during background noise rather than treating it as user speech."""
    from voice_pain_background_handoff import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
