"""Noise-class effects: background_noise, static, multiple_voices."""

from __future__ import annotations

import wave
from importlib.resources import files
from io import BytesIO
from pathlib import Path
from typing import Optional

import numpy as np

from ._common import EffectFn, np_to_pcm16, pcm16_to_np, rate

# Built-in presets for background_noise. NOT including "babble" — that is
# specifically the sample used by the multiple_voices effect, not a
# background_noise preset (source §4.5 L521 vs L533).
_BACKGROUND_PRESETS = {"cafe", "street", "office", "airport"}


def _load_sample(name: str) -> np.ndarray:
    """Load a bundled WAV as a PCM16 mono numpy array at 24kHz."""
    try:
        pkg = files("scenario.voice.assets.noise")
        wav_bytes = (pkg / f"{name}.wav").read_bytes()
    except (FileNotFoundError, ModuleNotFoundError):
        return np.zeros(0, dtype=np.int16)
    return _wav_to_np(wav_bytes)


def _wav_to_np(wav_bytes: bytes) -> np.ndarray:
    with wave.open(BytesIO(wav_bytes), "rb") as w:
        raw = w.readframes(w.getnframes())
        channels = w.getnchannels()
        sr = w.getframerate()
        sw = w.getsampwidth()
    if sw != 2:
        return np.zeros(0, dtype=np.int16)
    samples = np.frombuffer(raw, dtype=np.int16)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1).astype(np.int16)
    if sr != rate():
        new_len = max(1, int(round(len(samples) * rate() / sr)))
        idx = np.linspace(0, len(samples) - 1, new_len).astype(np.int64)
        samples = samples[idx]
    return samples


def background_noise(preset_or_path: str, volume: float = 0.3) -> EffectFn:
    """
    Overlay ambient noise. ``preset_or_path`` is one of the bundled presets
    (``cafe``, ``street``, ``office``, ``airport``) or a path to a WAV file.
    """
    if preset_or_path in _BACKGROUND_PRESETS:
        sample = _load_sample(preset_or_path)
    else:
        # Only treat the argument as a filesystem path when it clearly is one
        # (contains a separator or ends with .wav). Avoids the cwd-relative
        # footgun where "cfae" (typo of "cafe") matches a stray local file.
        looks_like_path = (
            "/" in preset_or_path
            or "\\" in preset_or_path
            or preset_or_path.lower().endswith(".wav")
        )
        if not looks_like_path:
            raise ValueError(
                f"background_noise: preset {preset_or_path!r} is not one of "
                f"{sorted(_BACKGROUND_PRESETS)}. To load a custom WAV pass a "
                "path containing a separator or ending with .wav."
            )
        p = Path(preset_or_path)
        if not p.exists():
            raise ValueError(
                f"background_noise: path {preset_or_path!r} does not exist"
            )
        sample = _wav_to_np(p.read_bytes())

    def _apply(audio: bytes) -> bytes:
        signal = pcm16_to_np(audio).astype(np.float32)
        if len(sample) == 0 or len(signal) == 0:
            return audio
        # Tile the noise to match signal length.
        reps = (len(signal) + len(sample) - 1) // len(sample)
        noise = np.tile(sample.astype(np.float32), reps)[: len(signal)]
        mixed = signal + noise * float(volume)
        return np_to_pcm16(mixed)

    return _apply


def static(intensity: float = 0.05) -> EffectFn:
    """Overlay white-noise static at the given intensity (fraction of full scale)."""

    def _apply(audio: bytes) -> bytes:
        signal = pcm16_to_np(audio).astype(np.float32)
        if len(signal) == 0:
            return audio
        noise = (np.random.default_rng().standard_normal(len(signal)) * 32767 * intensity)
        return np_to_pcm16(signal + noise)

    return _apply


def multiple_voices(background_audio: Optional[str] = None) -> EffectFn:
    """Mix with a babble speech sample to simulate background conversation."""
    sample = _load_sample("babble") if background_audio is None else _wav_to_np(Path(background_audio).read_bytes())

    def _apply(audio: bytes) -> bytes:
        signal = pcm16_to_np(audio).astype(np.float32)
        if len(sample) == 0 or len(signal) == 0:
            return audio
        reps = (len(signal) + len(sample) - 1) // len(sample)
        babble = np.tile(sample.astype(np.float32), reps)[: len(signal)]
        return np_to_pcm16(signal + babble * 0.3)

    return _apply
