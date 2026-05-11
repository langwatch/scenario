"""
E2E wrapper for pain pattern — "background handoff" should not trigger
agent response.

AC: judge checks the agent waits rather than responding to background audio.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_pain_background_handoff_e2e_success(requires_llm, requires_pipecat_bot):
    """Agent waits during background noise rather than treating it as user speech."""
    from background_handoff import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
