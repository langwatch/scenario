"""Unit tests for VoiceRecording, AudioSegment, VoiceEvent, LatencyMetrics."""

import json
import wave
from io import BytesIO

import pytest

from scenario.voice import AudioSegment, LatencyMetrics, VoiceEvent, VoiceRecording
from scenario.voice.recording import SpeakerRole


def _segment(speaker: str, start: float, end: float) -> AudioSegment:
    # 100ms of silence per segment
    return AudioSegment(speaker=speaker, start_time=start, end_time=end,  # type: ignore[arg-type,misc,index]
                        audio=b"\x00\x00" * 2400, transcript="hi")


def test_empty_recording_has_zero_duration():
    assert VoiceRecording().duration == 0.0


def test_recording_duration_is_max_end_time():
    rec = VoiceRecording(segments=[
        _segment("user", 0.0, 1.0),
        _segment("agent", 1.2, 3.5),
    ])
    assert rec.duration == 3.5


def test_full_wav_returns_valid_wav_container():
    rec = VoiceRecording(segments=[_segment("user", 0.0, 0.1)])
    with wave.open(BytesIO(rec.full_wav), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getframerate() == 24000
        assert w.getsampwidth() == 2


def test_audio_segment_exposes_required_attributes():
    seg = _segment("user", 0.0, 2.3)
    assert seg.speaker == "user"
    assert seg.start_time == 0.0
    assert seg.end_time == 2.3
    assert isinstance(seg.audio, bytes)
    assert seg.transcript == "hi"


def test_voice_event_has_time_and_type():
    ev = VoiceEvent(time=2.5, type="agent_start_speaking", latency=0.2)
    assert ev.time == 2.5
    assert ev.type == "agent_start_speaking"
    assert ev.latency == 0.2


def test_latency_metrics_from_measurements():
    lm = LatencyMetrics(measurements=[0.1, 0.2, 0.3, 0.4, 0.5])
    assert lm.avg_response_time == pytest.approx(0.3)
    assert lm.p50_response_time == pytest.approx(0.3)
    assert lm.p95_response_time == pytest.approx(0.5)


def test_latency_metrics_empty_returns_none():
    lm = LatencyMetrics()
    assert lm.avg_response_time is None
    assert lm.p50_response_time is None
    assert lm.p95_response_time is None


def test_recording_save_wav_writes_file(tmp_path):
    rec = VoiceRecording(segments=[_segment("user", 0.0, 0.1)])
    out = rec.save(tmp_path / "out.wav")
    assert out.exists()
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 1


# ---------------------------------------------------------------------------
# save_segments
# ---------------------------------------------------------------------------

def _seg_pcm(
    speaker: SpeakerRole, start: float, end: float, transcript: str = "hello"
) -> AudioSegment:
    """50 ms of silence at 16 kHz PCM16 (1600 bytes)."""
    return AudioSegment(
        speaker=speaker,
        start_time=start,
        end_time=end,
        audio=b"\x00" * 1600,
        transcript=transcript,
    )


def test_save_segments_writes_per_segment_files_and_full_and_manifest(tmp_path):
    rec = VoiceRecording(segments=[
        _seg_pcm("user", 0.0, 0.05, "hello"),
        _seg_pcm("agent", 0.312, 0.8, "hi there"),
    ])
    result_dir = rec.save_segments(tmp_path)
    assert result_dir == tmp_path.resolve()

    # Segment files — names derived from sorted start times
    seg_dir = tmp_path / "segments"
    assert seg_dir.is_dir()
    seg_files = sorted(seg_dir.iterdir())
    assert len(seg_files) == 2
    assert seg_files[0].name == "00-user-0000ms.wav"
    assert seg_files[1].name.startswith("01-agent-")
    for f in seg_files:
        assert f.stat().st_size > 0

    # full.wav
    full_wav = tmp_path / "full.wav"
    assert full_wav.exists()
    assert full_wav.stat().st_size > 0

    # manifest.json
    manifest_path = tmp_path / "manifest.json"
    assert manifest_path.exists()
    data = json.loads(manifest_path.read_text())
    assert data["segment_count"] == 2
    assert len(data["segments"]) == 2
    assert "generated_at" in data
    assert "duration" in data
    for entry in data["segments"]:
        file_on_disk = tmp_path / entry["file"]
        assert file_on_disk.exists(), f"segment file missing: {entry['file']}"


def test_save_segments_manifest_false_skips_manifest(tmp_path):
    rec = VoiceRecording(segments=[
        _seg_pcm("user", 0.0, 0.05),
        _seg_pcm("agent", 0.1, 0.2),
    ])
    rec.save_segments(tmp_path, manifest=False)

    assert not (tmp_path / "manifest.json").exists()
    # But segment files and full.wav are still written.
    seg_files = list((tmp_path / "segments").iterdir())
    assert len(seg_files) == 2
    assert (tmp_path / "full.wav").exists()


def test_save_segments_empty_recording_writes_empty_layout(tmp_path):
    rec = VoiceRecording(segments=[])
    rec.save_segments(tmp_path)

    seg_dir = tmp_path / "segments"
    assert seg_dir.is_dir()
    assert list(seg_dir.iterdir()) == []

    assert (tmp_path / "full.wav").exists()

    manifest_path = tmp_path / "manifest.json"
    assert manifest_path.exists()
    data = json.loads(manifest_path.read_text())
    assert data["segment_count"] == 0
    assert data["segments"] == []
