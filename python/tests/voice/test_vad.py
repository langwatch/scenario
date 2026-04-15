"""Unit tests for WebRTCVadFallback."""

import warnings

import numpy as np

from scenario.voice import AudioChunk, WebRTCVadFallback
from scenario.voice.vad import _WARNED_ADAPTERS


def _speech_pcm(duration_s: float, freq: float = 300.0) -> bytes:
    """Generate a pure tone — webrtcvad should classify this as speech."""
    sr = 24000
    t = np.arange(int(duration_s * sr)) / sr
    samples = (0.5 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)
    return samples.tobytes()


def _silence_pcm(duration_s: float) -> bytes:
    sr = 24000
    return b"\x00\x00" * int(duration_s * sr)


def test_vad_fallback_emits_userwarning_once_per_adapter():
    _WARNED_ADAPTERS.clear()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("TwilioAgent")
        WebRTCVadFallback("TwilioAgent")  # second instance must NOT re-warn
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    assert "TwilioAgent" in str(user_warnings[0].message)
    assert "native VAD" in str(user_warnings[0].message)
    assert "accuracy" in str(user_warnings[0].message).lower()


def test_vad_fallback_warns_per_adapter_name():
    _WARNED_ADAPTERS.clear()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("AdapterA")
        WebRTCVadFallback("AdapterB")
    assert len([w for w in captured if issubclass(w.category, UserWarning)]) == 2


def test_vad_detects_transitions_with_callbacks():
    _WARNED_ADAPTERS.clear()
    starts, ends = [], []
    vad = WebRTCVadFallback(
        "TestAdapter",
        aggressiveness=2,
        on_speech_start=lambda: starts.append(True),
        on_speech_end=lambda: ends.append(True),
    )
    # Feed silence, speech, silence.
    vad.process(AudioChunk(data=_silence_pcm(0.3)))
    vad.process(AudioChunk(data=_speech_pcm(0.5)))
    vad.process(AudioChunk(data=_silence_pcm(0.5)))
    # At least one transition in each direction.
    assert len(starts) >= 1
    assert len(ends) >= 1
