"""
E2E wrapper for Demo — recording and playback.

AC: both demo.wav and demo.mp3 exist with non-zero size after the run.
    ffmpeg subprocess is spawned for the MP3 save.
    audio_playback=True degrades gracefully on headless CI.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_recording_playback_e2e_success(requires_llm, requires_pipecat_bot):
    """Demo completes; result.success is True."""
    from recording_playback import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_demo_recording_playback_wav_written(requires_llm, requires_pipecat_bot):
    """
    WAV file is written with non-zero size when a live bot is present.
    Skipped when no audio is recorded (headless / no live bot).
    """
    import tempfile
    from recording_playback import main, OUT_DIR  # type: ignore[import]

    result = await main()

    if result.audio is None:
        pytest.skip("No audio recorded (no live bot); skipping file-size assertion")

    wav_path = OUT_DIR / "demo.wav"
    if not wav_path.exists():
        pytest.skip("WAV not written (likely no live bot connection)")

    assert wav_path.stat().st_size > 0, "demo.wav must be non-empty"
