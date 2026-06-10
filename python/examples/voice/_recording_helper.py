"""Shared helper used by all voice demos to write recordings to disk."""
from __future__ import annotations

import inspect
from pathlib import Path
from typing import Optional

from scenario.voice.recording import VoiceRecording

# Repo-relative recordings dir; resolves the same regardless of CWD inside python/.
# Recordings nest under ``outputs/`` alongside other future artifact types
# (logs, traces, screenshots) — see ``python/outputs/README.md``.
_RECORDINGS_ROOT = Path(__file__).resolve().parent.parent.parent / "outputs" / "recordings"


def save_demo_recording(
    audio: Optional[VoiceRecording],
    demo_name: Optional[str] = None,
) -> Optional[Path]:
    """
    If ``audio`` is non-None and has segments, write per-segment + full + manifest
    under ``python/outputs/recordings/<demo_name>/`` and return the directory path.
    Returns None if audio is None or has no segments.

    When ``demo_name`` is omitted, it defaults to the calling module's filename
    stem — e.g. ``examples/voice/basic_greeting.py`` writes to
    ``python/outputs/recordings/basic_greeting/``. Demos rarely need to override.

    The library itself stays neutral — only demos write to disk.
    """
    if audio is None or not audio.segments:
        return None
    if demo_name is None:
        caller_frame = inspect.stack()[1]
        demo_name = Path(caller_frame.filename).stem
    target = _RECORDINGS_ROOT / demo_name
    audio.save_segments(target, manifest=True)
    return target
