"""
E2E wrapper for pain pattern — "multi-intent" single turn.

AC: judge checks both intents (cancel subscription + check credits) are
addressed in the agent's response.
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
async def test_pain_multi_intent_e2e_success():
    """Agent addresses both intents in a single user turn."""
    from voice_pain_multi_intent import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
