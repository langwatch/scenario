"""
E2E wrapper for Example 6.3 — angry customer in noisy cafe.

AC: judge evaluates empathy, noise-robustness, and resolution.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_3_angry_customer_e2e_success(requires_llm, requires_pipecat_bot):
    """Scenario with angry customer persona and cafe noise runs without crashing."""
    from angry_customer import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
