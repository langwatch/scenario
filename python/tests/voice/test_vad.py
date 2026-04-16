"""Unit tests for WebRTCVadFallback."""

import warnings

import numpy as np

from scenario.voice import AudioChunk, WebRTCVadFallback


SR = 24000


def _high_energy_pcm(duration_s: float) -> bytes:
    """Dense broadband noise near full scale — webrtcvad classifies this as speech."""
    rng = np.random.default_rng(seed=42)
    samples = (rng.standard_normal(int(duration_s * SR)) * 16000).astype(np.int16)
    return samples.tobytes()


def _silence_pcm(duration_s: float) -> bytes:
    return b"\x00\x00" * int(duration_s * SR)


def test_vad_fallback_emits_userwarning_once_per_adapter():
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("TwilioAgentAdapter")
        WebRTCVadFallback("TwilioAgentAdapter")  # second instance must NOT re-warn
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    assert "TwilioAgentAdapter" in str(user_warnings[0].message)
    assert "native VAD" in str(user_warnings[0].message)
    assert "accuracy" in str(user_warnings[0].message).lower()


def test_vad_fallback_warns_per_adapter_name():
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("AdapterA")
        WebRTCVadFallback("AdapterB")
    assert len([w for w in captured if issubclass(w.category, UserWarning)]) == 2


def test_vad_detects_silence_to_voice_to_silence_transitions():
    # Use dense random-noise "voice" between two silence chunks. Broadband
    # high-energy audio is reliably classified as speech by webrtcvad at
    # aggressiveness 2, where a pure tone is not.
    WebRTCVadFallback.reset_warnings()
    starts, ends = [], []
    vad = WebRTCVadFallback(
        "TestAdapter",
        aggressiveness=2,
        on_speech_start=lambda: starts.append(True),
        on_speech_end=lambda: ends.append(True),
    )
    vad.process(AudioChunk(data=_silence_pcm(0.3)))
    vad.process(AudioChunk(data=_high_energy_pcm(0.8)))
    vad.process(AudioChunk(data=_silence_pcm(0.8)))
    # A silence→speech→silence sequence must produce at least one of each
    # transition. We allow >=1 rather than ==1 because webrtcvad can briefly
    # flicker between classifications around the boundary.
    assert len(starts) >= 1, "expected at least one speech-start transition"
    assert len(ends) >= 1, "expected at least one speech-end transition"
    # And the last transition must be back to silence.
    assert not vad.is_speaking


def test_vad_with_silence_only_never_fires_speech_start():
    WebRTCVadFallback.reset_warnings()
    starts = []
    vad = WebRTCVadFallback(
        "TestAdapter",
        on_speech_start=lambda: starts.append(True),
    )
    vad.process(AudioChunk(data=_silence_pcm(1.0)))
    assert starts == []
    assert not vad.is_speaking
