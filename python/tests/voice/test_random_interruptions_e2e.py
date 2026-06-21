"""
E2E wrapper for Example 6.7 — random interruptions via interrupt_probability.

AC: result.success is True; interruptions occur and the judge evaluates
recovery and context preservation.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.voice_multiturn  # runs in its own process; see TESTING.md (issue #491)
@pytest.mark.asyncio
async def test_example_6_7_random_interruptions_e2e(requires_llm, requires_pipecat_bot):
    """Scenario with interrupt_probability=0.4 over 5 turns.

    Single run covers both AC invariants:
    1. result.success True,
    2. result.timeline contains voice events (user_interrupt events appear
       when a live adapter drives interruption).
    """
    from random_interruptions import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
    assert result.timeline, "Expected voice events in timeline"
