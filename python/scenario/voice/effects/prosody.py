"""Prosody effects: volume scaling and time-stretching speech."""

from __future__ import annotations

import numpy as np

from ._common import EffectFn, np_to_pcm16, pcm16_to_np


def low_volume(factor: float = 0.5) -> EffectFn:
    """Scale amplitude down by ``factor`` (0 < factor <= 1)."""
    if factor <= 0:
        raise ValueError("low_volume factor must be > 0")

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).astype(np.float32) * factor
        return np_to_pcm16(arr)

    return _apply


def high_volume(factor: float = 1.5) -> EffectFn:
    """Scale amplitude up by ``factor`` (>= 1). Clips at int16 bounds."""
    if factor < 1:
        raise ValueError("high_volume factor must be >= 1")

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).astype(np.float32) * factor
        return np_to_pcm16(arr)

    return _apply


def speaking_fast(factor: float = 1.3) -> EffectFn:
    """
    Time-stretch to speak faster (factor > 1). Linear resample, so pitch shifts.

    Source table says "time-stretch without pitch change" — true pitch-preserving
    stretching needs phase vocoder. Our implementation prioritises simplicity
    and zero extra deps; pitch shift is a documented tradeoff.
    """
    if factor <= 1:
        raise ValueError("speaking_fast factor must be > 1")
    return _resample_factor(factor)


def speaking_slow(factor: float = 0.7) -> EffectFn:
    """Time-stretch to speak slower (factor < 1). Same pitch tradeoff as speaking_fast."""
    if factor >= 1:
        raise ValueError("speaking_slow factor must be < 1")
    return _resample_factor(factor)


def _resample_factor(factor: float) -> EffectFn:
    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio)
        if len(arr) == 0:
            return audio
        new_len = max(1, int(round(len(arr) / factor)))
        idx = np.linspace(0, len(arr) - 1, new_len).astype(np.int64)
        return np_to_pcm16(arr[idx])

    return _apply
