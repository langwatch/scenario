"""
E2E wrapper for Demo — Pipecat full-scenario flow.

AC: result.success is True end-to-end against the bundled Pipecat stub bot.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_pipecat_scenario_e2e_success(requires_llm, requires_pipecat_bot):
    """Pipecat full-scenario flow completes and result.success is True."""
    from pipecat_scenario import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
