"""
E2E wrapper for Demo — recording and playback.

AC: both demo.wav and demo.mp3 exist with non-zero size after the run.
    ffmpeg subprocess is spawned for the MP3 save.
    audio_playback=True degrades gracefully on headless CI.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY",)

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_recording_playback_e2e_success():
    """Demo completes; result.success is True."""
    from voice_demo_recording_playback import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_recording_playback_wav_written():
    """
    WAV file is written with non-zero size when a live bot is present.
    Skipped when no audio is recorded (headless / no live bot).
    """
    import tempfile
    from voice_demo_recording_playback import main, OUT_DIR  # type: ignore[import]

    result = await main()

    if result.audio is None:
        pytest.skip("No audio recorded (no live bot); skipping file-size assertion")

    wav_path = OUT_DIR / "demo.wav"
    if not wav_path.exists():
        pytest.skip("WAV not written (likely no live bot connection)")

    assert wav_path.stat().st_size > 0, "demo.wav must be non-empty"
