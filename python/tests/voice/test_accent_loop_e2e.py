"""
E2E wrapper for pain pattern — "accent misunderstanding" loop escape.

AC: judge checks the agent offers an alternative input method after 2 failed
attempts and does not repeat the same question more than 3 times.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.voice_multiturn  # runs in its own process; see TESTING.md (issue #491)
@pytest.mark.asyncio
async def test_pain_accent_loop_e2e_success(requires_llm, requires_pipecat_bot):
    """Agent offers alternative input after repeated accent misunderstandings."""
    from accent_loop import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
