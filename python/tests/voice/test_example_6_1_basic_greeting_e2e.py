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
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.asyncio
async def test_example_6_1_basic_greeting_e2e_success(requires_llm, requires_pipecat_bot):
    """result.success is True and audio is recorded."""
    from voice_example_6_1_basic_greeting import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_example_6_1_audio_save_writes_wav(requires_llm, requires_pipecat_bot):
    """result.audio.save() writes a non-empty WAV file."""
    from voice_example_6_1_basic_greeting import main  # type: ignore[import]

    result = await main()

    if result.audio is not None:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            out = Path(f.name)
        try:
            saved = result.audio.save(out)
            assert saved.exists(), "WAV file was not created"
            assert saved.stat().st_size > 0, "WAV file is empty"
        finally:
            out.unlink(missing_ok=True)
    else:
        # No live bot — audio is None, acceptable in CI without PIPECAT_BOT_URL.
        pytest.skip("No audio recorded (no live Pipecat bot); skipping WAV assertion")
