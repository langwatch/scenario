"""
E2E wrapper for Example 6.1 — basic greeting flow.

AC: result.success is True AND result.audio.save() writes a WAV file.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

# Add examples dir to path so we can import the example.
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_1_basic_greeting_e2e(requires_llm, requires_pipecat_bot):
    """Single run covers both AC invariants:
    1. result.success True (judge passed criteria),
    2. result.audio.save() writes a non-empty WAV.

    Previously split into two tests, each calling main() independently —
    doubled LLM + bot cost for no semantic gain. Consolidated.
    """
    from basic_greeting import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
    assert result.audio is not None, (
        "Expected recorded audio with a live Pipecat bot — "
        "result.audio is None. Is the bot reachable?"
    )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out = Path(f.name)
    try:
        saved = result.audio.save(out)
        assert saved.exists(), "WAV file was not created"
        assert saved.stat().st_size > 0, "WAV file is empty"
    finally:
        out.unlink(missing_ok=True)
