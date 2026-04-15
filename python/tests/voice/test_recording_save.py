"""
Unit tests for VoiceRecording.save() path/format safety.
"""

import pytest

from scenario.voice import AudioSegment, VoiceRecording


def _one_segment_recording() -> VoiceRecording:
    return VoiceRecording(segments=[
        AudioSegment(speaker="user", start_time=0.0, end_time=0.1,
                     audio=b"\x00\x00" * 2400),
    ])


def test_save_rejects_unknown_format(tmp_path):
    rec = _one_segment_recording()
    with pytest.raises(ValueError) as excinfo:
        rec.save(tmp_path / "out.weird", format="weird")
    msg = str(excinfo.value)
    assert "weird" in msg
    # Allowlist is part of the error message so users know what IS supported.
    assert "wav" in msg and "mp3" in msg


def test_save_resolves_path(tmp_path):
    rec = _one_segment_recording()
    # A path with .. in it — .resolve() collapses it, no traversal warning.
    out = rec.save(tmp_path / "sub" / ".." / "out.wav")
    assert out.is_absolute()
    assert out.exists()


def test_save_infers_format_from_suffix(tmp_path):
    rec = _one_segment_recording()
    out = rec.save(tmp_path / "out.wav")
    assert out.exists()
    assert out.read_bytes()[:4] == b"RIFF"


def test_save_mp3_transcodes_via_ffmpeg(tmp_path):
    # This runs the real ffmpeg subprocess (bundled via imageio-ffmpeg) —
    # exercises the non-WAV code path end-to-end.
    rec = _one_segment_recording()
    out = rec.save(tmp_path / "out.mp3")
    assert out.exists()
    assert out.stat().st_size > 0
    # MP3 typically starts with ID3 tag or FF FB sync marker.
    first = out.read_bytes()[:3]
    assert first == b"ID3" or first[:2] == b"\xff\xfb"
