"""Unit tests for VoiceRecording, AudioSegment, VoiceEvent, LatencyMetrics."""

import wave
from io import BytesIO

import pytest

from scenario.voice import AudioSegment, LatencyMetrics, VoiceEvent, VoiceRecording


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
