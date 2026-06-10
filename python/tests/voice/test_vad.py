"""Unit tests for WebRTCVadFallback."""

import warnings

import numpy as np
import pytest

from scenario.voice import AudioChunk, WebRTCVadFallback


SR = 24000


def _high_energy_pcm(duration_s: float) -> bytes:
    """Dense broadband noise near full scale — webrtcvad classifies this as speech."""
    rng = np.random.default_rng(seed=42)
    samples = (rng.standard_normal(int(duration_s * SR)) * 16000).astype(np.int16)
    return samples.tobytes()


def _silence_pcm(duration_s: float) -> bytes:
    return b"\x00\x00" * int(duration_s * SR)


def test_vad_fallback_warning_message_names_adapter_and_accuracy_caveat():
    """Content-shape assertion separate from the rate-limit shape below."""
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("TwilioAgentAdapter")
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    msg = str(user_warnings[0].message)
    assert "TwilioAgentAdapter" in msg
    assert "native VAD" in msg
    assert "accuracy" in msg.lower()


@pytest.mark.parametrize(
    "adapter_names, expected_warning_count",
    [
        # Same name twice on same instance pair → one warning. The
        # ClassVar set memoizes by adapter_name string, not class identity.
        (["A", "A"], 1),
        # Two distinct names → two warnings.
        (["A", "B"], 2),
        # Cross-instance with the same string → still one warning. Locks
        # in that the dedupe is across *all* instances of the fallback,
        # not just within a single instance's lifetime.
        (["SameName", "SameName"], 1),
    ],
)
def test_vad_fallback_rate_limits_by_adapter_name(adapter_names, expected_warning_count):
    """``WebRTCVadFallback._warned_adapters`` rate-limits the
    "no native VAD" UserWarning by the caller-supplied adapter_name
    string, regardless of how many fallback instances are constructed.
    """
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        for name in adapter_names:
            WebRTCVadFallback(name)
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == expected_warning_count


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
