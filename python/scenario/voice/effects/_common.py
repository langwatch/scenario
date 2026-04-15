"""Shared helpers for effect implementations. PCM16 @ 24kHz mono bytes <-> numpy int16."""

from __future__ import annotations

from typing import Callable

import numpy as np

from ..audio_chunk import PCM16_SAMPLE_RATE


EffectFn = Callable[[bytes], bytes]


def pcm16_to_np(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.int16).copy()


def np_to_pcm16(arr: np.ndarray) -> bytes:
    return np.clip(arr, -32768, 32767).astype(np.int16).tobytes()


def rate() -> int:
    return PCM16_SAMPLE_RATE
