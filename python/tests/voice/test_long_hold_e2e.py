"""
E2E wrapper for pain pattern — "long hold" feedback during 15s tool call.

AC: judge checks "Agent provides audio feedback while waiting".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.voice_multiturn  # runs in its own process; see TESTING.md (issue #491)
@pytest.mark.asyncio
async def test_pain_long_hold_e2e_success(requires_llm, requires_pipecat_bot):
    """Agent provides feedback during a 15s simulated hold; scenario succeeds."""
    from long_hold import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
