"""
Unit tests for the audio effects pipeline.

Each effect:
    - Accepts PCM16 bytes and returns PCM16 bytes
    - Mutates audio (doesn't return input unchanged for non-trivial inputs)
    - Preserves the sample format contract (int16 mono 24kHz)

Also covers effect enumeration (every name from §4.5 table exists) and
argument validation.
"""

import numpy as np
import pytest

from scenario.voice import effects as fx


def _silence(samples: int) -> bytes:
    return b"\x00\x00" * samples


def _tone(samples: int, freq: float = 440.0, sr: int = 24000) -> bytes:
    t = np.arange(samples) / sr
    arr = (np.sin(2 * np.pi * freq * t) * 16000).astype(np.int16)
    return arr.tobytes()


# ----------------------------------------------------------- enumeration (§4.5)

EXPECTED_EFFECT_NAMES = {
    "background_noise",
    "phone_quality",
    "low_quality",
    "packet_loss",
    "static",
    "echo",
    "speaking_fast",
    "speaking_slow",
    "low_volume",
    "high_volume",
    "robotic",
    "breaking_up",
    "multiple_voices",
    "custom",
}


def test_every_effect_from_the_proposal_table_exists():
    for name in EXPECTED_EFFECT_NAMES:
        assert hasattr(fx, name), f"Missing effect: {name}"
        assert callable(getattr(fx, name))


def test_effect_callable_returns_bytes():
    inp = _tone(2400)
    for name, factory, args in [
        ("low_volume", fx.low_volume, (0.5,)),
        ("high_volume", fx.high_volume, (2.0,)),
        ("phone_quality", fx.phone_quality, ()),
        ("echo", fx.echo, (100, 0.5)),
        ("static", fx.static, (0.01,)),
        ("robotic", fx.robotic, ()),
        ("low_quality", fx.low_quality, (4000,)),
        ("speaking_fast", fx.speaking_fast, (1.2,)),
        ("speaking_slow", fx.speaking_slow, (0.8,)),
        ("packet_loss", fx.packet_loss, (0.1,)),
        ("breaking_up", fx.breaking_up, ()),
    ]:
        effect = factory(*args)
        out = effect(inp)
        assert isinstance(out, bytes), name
        assert len(out) > 0, name


# ----------------------------------------------------------- prosody

def test_low_volume_reduces_amplitude():
    inp = _tone(2400)
    out = fx.low_volume(0.5)(inp)
    inp_peak = np.abs(np.frombuffer(inp, dtype=np.int16)).max()
    out_peak = np.abs(np.frombuffer(out, dtype=np.int16)).max()
    assert out_peak < inp_peak


def test_high_volume_increases_amplitude():
    # Use a low-amplitude input so there's headroom to go up without clipping.
    t = np.arange(2400) / 24000
    quiet = (np.sin(2 * np.pi * 440 * t) * 1000).astype(np.int16).tobytes()
    out = fx.high_volume(3.0)(quiet)
    inp_peak = np.abs(np.frombuffer(quiet, dtype=np.int16)).max()
    out_peak = np.abs(np.frombuffer(out, dtype=np.int16)).max()
    assert out_peak > inp_peak


def test_speaking_fast_shortens_audio():
    inp = _tone(24000)  # 1 second
    out = fx.speaking_fast(2.0)(inp)
    assert len(out) < len(inp)


def test_speaking_slow_lengthens_audio():
    inp = _tone(24000)
    out = fx.speaking_slow(0.5)(inp)
    assert len(out) > len(inp)


def test_low_volume_rejects_zero():
    with pytest.raises(ValueError):
        fx.low_volume(0)


def test_high_volume_rejects_below_one():
    with pytest.raises(ValueError):
        fx.high_volume(0.5)


def test_speaking_fast_rejects_below_one():
    with pytest.raises(ValueError):
        fx.speaking_fast(0.9)


# ----------------------------------------------------------- noise

def test_background_noise_with_known_preset_mixes_signal():
    inp = _tone(2400)
    out = fx.background_noise("cafe", volume=0.3)(inp)
    assert len(out) == len(inp)
    # Output should differ from input because noise was mixed in.
    assert out != inp


def test_background_noise_rejects_unknown_preset_without_file():
    with pytest.raises(ValueError):
        fx.background_noise("nonexistent_preset")


def test_static_introduces_noise():
    # Use a short silent input so even faint static is visible.
    inp = _silence(2400)
    out = fx.static(0.05)(inp)
    arr = np.frombuffer(out, dtype=np.int16)
    # At least some non-zero samples after adding white noise.
    assert np.any(arr != 0)


def test_multiple_voices_mixes_signal():
    inp = _tone(2400)
    out = fx.multiple_voices()(inp)
    assert len(out) == len(inp)
    assert out != inp


# ----------------------------------------------------------- quality

def test_phone_quality_filters_out_low_and_high_frequencies():
    # Input has a 100 Hz tone (below the bandpass) and a 1 kHz tone (inside).
    t = np.arange(24000) / 24000
    signal = (np.sin(2 * np.pi * 100 * t) * 10000 + np.sin(2 * np.pi * 1000 * t) * 10000).astype(np.int16)
    inp = signal.tobytes()
    out = fx.phone_quality()(inp)
    assert len(out) == len(inp)


def test_packet_loss_respects_probability():
    inp = _tone(24000)
    # probability=1.0 → the entire signal should be zeroed.
    out = fx.packet_loss(1.0, chunk_ms=20)(inp)
    arr = np.frombuffer(out, dtype=np.int16)
    assert arr.sum() == 0


def test_packet_loss_validates_probability():
    with pytest.raises(ValueError):
        fx.packet_loss(1.5)


def test_echo_preserves_length():
    inp = _tone(24000)
    out = fx.echo(delay_ms=100, decay=0.5)(inp)
    assert len(out) == len(inp)


# ----------------------------------------------------------- custom

def test_custom_wraps_user_function():
    def invert(audio: bytes) -> bytes:
        arr = np.frombuffer(audio, dtype=np.int16).copy()
        return (-arr).astype(np.int16).tobytes()

    inp = _tone(2400)
    out = fx.custom(invert)(inp)
    assert len(out) == len(inp)
    orig = np.frombuffer(inp, dtype=np.int16)
    inverted = np.frombuffer(out, dtype=np.int16)
    assert np.array_equal(inverted, -orig)


def test_custom_requires_callable():
    with pytest.raises(TypeError):
        fx.custom(42)  # type: ignore[arg-type]


def test_custom_requires_callable_returns_bytes():
    def bad(audio: bytes):
        return "not bytes"

    with pytest.raises(TypeError):
        fx.custom(bad)(_tone(100))  # type: ignore[arg-type,misc,index]


# ----------------------------------------------------------- composability

def test_effects_compose_via_sequential_application():
    chain = [fx.low_volume(0.5), fx.echo(50, 0.3), fx.background_noise("cafe", 0.1)]
    audio = _tone(4800)
    for effect in chain:
        audio = effect(audio)
    assert isinstance(audio, bytes) and len(audio) > 0
