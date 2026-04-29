"""
E2E wrapper for Demo — ElevenLabs composable + branded agent.

AC: the branded ElevenLabsVoiceAgent runs end-to-end and result.success is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_elevenlabs_branded_e2e(requires_llm, requires_elevenlabs_paid_voice):
    """Branded ElevenLabsVoiceAgent runs end-to-end; result.success is True.

    The seam-firing contract (STT + LLM + TTS each called) is covered by
    unit tests against ComposableVoiceAgent — exercising it again at e2e
    scope pays the LLM+ElevenLabs TTS cost twice with no additional
    coverage. Consolidated from two near-identical tests.
    """
    from elevenlabs_branded import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
