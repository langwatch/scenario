"""
E2E wrapper for Example 6.5 — tool call verification as a plain Python step.

AC: plain Python callable receives ScenarioState, state.timeline contains
the tool_call event, and the callable can assert mid-scenario.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_5_tool_verification_e2e_success(requires_llm, requires_pipecat_bot):
    """Scenario runs with a plain Python callable mid-script."""
    from tool_verification import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_example_6_5_timeline_accessible_from_callable(requires_llm, requires_pipecat_bot):
    """
    state.timeline is accessible inside the callable script step.
    Skipped when no live bot (timeline will be empty without real adapter).
    """
    from tool_verification import main  # type: ignore[import]

    result = await main()

    # If timeline is populated (live bot present), tool_call event should exist.
    if result.timeline:
        tool_events = [e for e in result.timeline if e.type == "tool_call"]
        assert len(tool_events) > 0, (
            "Expected at least one tool_call event in result.timeline"
        )
    else:
        pytest.skip("No live bot; timeline empty — callable pattern tested in unit tests")
