"""
E2E wrapper for Example 6.2 — interruption recovery.

AC: result.success is True AND result.latency.interrupt_response_time < 1.0.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_2_interruption_recovery_e2e_success(requires_llm, requires_pipecat_bot):
    """Scenario succeeds with a voice interruption in the script."""
    from interruption_recovery import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_example_6_2_interrupt_response_time(requires_llm, requires_pipecat_bot):
    """
    interrupt_response_time is populated and under 1.0s.
    Skipped when no live bot (latency will be None without a real adapter).
    """
    from interruption_recovery import main  # type: ignore[import]

    result = await main()

    if result.latency is None or result.latency.interrupt_response_time is None:
        pytest.skip("No live bot; latency not populated")

    assert result.latency.interrupt_response_time < 1.0, (
        f"interrupt_response_time {result.latency.interrupt_response_time:.3f}s "
        "must be < 1.0s"
    )
