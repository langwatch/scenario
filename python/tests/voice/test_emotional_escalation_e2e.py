"""
E2E wrapper for pain pattern — "emotional escalation" detection and adjustment.

AC: judge checks the agent detects the tone shift and offers empathy or
human escalation.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.skip(reason="Hangs in full suite (not in isolation) — multi-turn max_turns demos wedge pytest process. Same pattern as 6.3, 6.7. Scoped to follow-up per #350 narrowing decision (cut from narrowed PR).")
@pytest.mark.asyncio
async def test_pain_emotional_escalation_e2e_success(requires_llm, requires_pipecat_bot):
    """Agent detects emotional escalation and responds with empathy."""
    from emotional_escalation import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
