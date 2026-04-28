"""Shared helper used by all voice demos to write recordings to disk."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from scenario.voice.recording import VoiceRecording

# Repo-relative recordings dir; resolves the same regardless of CWD inside python/.
_RECORDINGS_ROOT = Path(__file__).resolve().parent.parent / "recordings"


def save_demo_recording(audio: Optional[VoiceRecording], demo_name: str) -> Optional[Path]:
    """
    If ``audio`` is non-None and has segments, write per-segment + full + manifest
    under ``python/recordings/<demo_name>/`` and return the directory path.
    Returns None if audio is None or has no segments.

    Demos call this opt-in pattern after they get a result back. The library
    itself stays neutral — only demos write to disk.
    """
    if audio is None or not audio.segments:
        return None
    target = _RECORDINGS_ROOT / demo_name
    audio.save_segments(target, manifest=True)
    return target
