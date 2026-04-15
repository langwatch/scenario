"""
Unit tests for ScenarioResult voice fields (§4.6).
"""

from scenario.types import ScenarioResult
from scenario.voice import AudioSegment, LatencyMetrics, VoiceEvent, VoiceRecording


def test_scenario_result_backward_compatible():
    # Existing callers that construct ScenarioResult without voice fields work.
    r = ScenarioResult(success=True, messages=[])
    assert r.audio is None
    assert r.timeline is None
    assert r.latency is None


def test_scenario_result_accepts_voice_outputs():
    rec = VoiceRecording(segments=[
        AudioSegment(speaker="user", start_time=0.0, end_time=0.5, audio=b"\x00" * 24000),
    ])
    tl = [VoiceEvent(time=0.0, type="user_start_speaking")]
    lm = LatencyMetrics(measurements=[0.2])
    r = ScenarioResult(
        success=True,
        messages=[],
        audio=rec,
        timeline=tl,
        latency=lm,
    )
    assert r.audio is rec
    assert r.timeline == tl
    assert r.latency is lm


def test_voice_event_serialises_minimum_fields():
    ev = VoiceEvent(time=2.5, type="agent_start_speaking", latency=0.2)
    assert ev.time == 2.5
    assert ev.type == "agent_start_speaking"
    assert ev.latency == 0.2
