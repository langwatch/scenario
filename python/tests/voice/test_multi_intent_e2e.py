"""
E2E wrapper for pain pattern — "multi-intent" single turn.

AC: judge checks both intents (cancel subscription + check credits) are
addressed in the agent's response.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.skip(reason="Hangs in full suite (not in isolation) — multi-turn max_turns demos wedge pytest process. Same pattern as 6.3, 6.7. Scoped to follow-up per #350 narrowing decision (cut from narrowed PR).")
@pytest.mark.asyncio
async def test_pain_multi_intent_e2e_success(requires_llm, requires_pipecat_bot):
    """Agent addresses both intents in a single user turn."""
    from multi_intent import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
