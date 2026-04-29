"""
E2E wrapper for Example 6.8 — silence handling.

AC: agent prompts during 10s silence and result.success is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.skip(reason="Hangs in full suite (not in isolation) — multi-turn max_turns demos wedge pytest process. Same pattern as 6.3, 6.7. Scoped to follow-up per #350 narrowing decision (cut from narrowed PR).")
@pytest.mark.asyncio
async def test_example_6_8_silence_handling_e2e_success(requires_llm, requires_pipecat_bot):
    """Silence injection scenario completes with result.success True."""
    from silence_handling import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
