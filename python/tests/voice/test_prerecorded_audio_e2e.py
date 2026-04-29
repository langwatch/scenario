"""
E2E wrapper for Example 6.6 — pre-recorded audio injection.

AC: judge evaluates whether the agent asks for clarification after
receiving a mumbly/inaudible pre-recorded audio clip.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_6_prerecorded_audio_e2e_success(requires_llm, requires_pipecat_bot):
    """Pre-recorded audio injected as first turn; scenario completes."""
    from prerecorded_audio import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
