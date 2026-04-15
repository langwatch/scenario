"""Quality-degradation effects: phone_quality, low_quality, packet_loss, echo, robotic, breaking_up."""

from __future__ import annotations

import numpy as np

from ._common import EffectFn, np_to_pcm16, pcm16_to_np, rate


def phone_quality() -> EffectFn:
    """Bandpass 300Hz-3.4kHz + amplitude compression to mimic a phone line."""

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).astype(np.float32)
        if len(arr) == 0:
            return audio
        # Simple bandpass via FFT — cheap and dependency-free.
        fft = np.fft.rfft(arr)
        freqs = np.fft.rfftfreq(len(arr), d=1.0 / rate())
        mask = (freqs >= 300) & (freqs <= 3400)
        fft *= mask
        filtered = np.fft.irfft(fft, n=len(arr))
        # Mild compression (saturate)
        compressed = np.tanh(filtered / 16000.0) * 16000.0
        return np_to_pcm16(compressed)

    return _apply


def low_quality(bitrate: int = 8000) -> EffectFn:
    """Downsample to ``bitrate`` Hz and back, simulating a low-bitrate codec."""

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio)
        if len(arr) == 0 or bitrate >= rate():
            return audio
        # Downsample then upsample — introduces aliasing and quantisation noise.
        down_len = max(1, int(len(arr) * bitrate / rate()))
        down_idx = np.linspace(0, len(arr) - 1, down_len).astype(np.int64)
        down = arr[down_idx]
        up_idx = np.linspace(0, len(down) - 1, len(arr)).astype(np.int64)
        return np_to_pcm16(down[up_idx])

    return _apply


def packet_loss(probability: float = 0.05, chunk_ms: int = 20) -> EffectFn:
    """Zero out random ``chunk_ms`` windows at the given probability."""
    if not 0 <= probability <= 1:
        raise ValueError("packet_loss probability must be in [0, 1]")

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).copy()
        if len(arr) == 0:
            return audio
        chunk_samples = max(1, (rate() * chunk_ms) // 1000)
        rng = np.random.default_rng()
        for i in range(0, len(arr), chunk_samples):
            if rng.random() < probability:
                arr[i : i + chunk_samples] = 0
        return np_to_pcm16(arr)

    return _apply


def echo(delay_ms: int = 200, decay: float = 0.5) -> EffectFn:
    """Overlay a delayed/attenuated copy of the signal."""

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).astype(np.float32)
        if len(arr) == 0:
            return audio
        delay_samples = (rate() * delay_ms) // 1000
        if delay_samples >= len(arr):
            return audio
        delayed = np.zeros_like(arr)
        delayed[delay_samples:] = arr[:-delay_samples] * decay
        return np_to_pcm16(arr + delayed)

    return _apply


def robotic() -> EffectFn:
    """Crude vocoder-ish effect: ring-modulate the signal with a low-freq carrier."""

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).astype(np.float32)
        if len(arr) == 0:
            return audio
        t = np.arange(len(arr)) / rate()
        carrier = np.sin(2 * np.pi * 100 * t)
        return np_to_pcm16(arr * carrier)

    return _apply


def breaking_up() -> EffectFn:
    """Simulate intermittent connection: larger and more frequent dropouts than packet_loss."""

    def _apply(audio: bytes) -> bytes:
        arr = pcm16_to_np(audio).copy()
        if len(arr) == 0:
            return audio
        chunk_samples = (rate() * 100) // 1000  # 100ms windows
        rng = np.random.default_rng()
        for i in range(0, len(arr), chunk_samples):
            if rng.random() < 0.2:
                arr[i : i + chunk_samples] = 0
        return np_to_pcm16(arr)

    return _apply
