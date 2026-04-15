"""Generate synthetic CC0 noise samples bundled with the package."""
from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np


SR = 24000
DURATION = 0.5


def _save(path: Path, samples: np.ndarray) -> None:
    samples = np.clip(samples, -32767, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(samples.tobytes())


def _pink_noise(duration: float) -> np.ndarray:
    n = int(SR * duration)
    X = np.random.randn(n // 2 + 1) + 1j * np.random.randn(n // 2 + 1)
    S = np.sqrt(np.arange(len(X)) + 1.0)
    y = np.fft.irfft(X / S, n=n).real
    y = y / (np.max(np.abs(y)) + 1e-9) * 16000
    return y


def _cafe() -> np.ndarray:
    pink = _pink_noise(DURATION) * 0.7
    t = np.arange(int(SR * DURATION)) / SR
    tone = 2000 * np.sin(2 * math.pi * 220 * t) * 0.2
    return pink + tone


def _street() -> np.ndarray:
    pink = _pink_noise(DURATION)
    t = np.arange(int(SR * DURATION)) / SR
    rumble = 6000 * np.sin(2 * math.pi * 80 * t)
    return pink * 0.5 + rumble


def _office() -> np.ndarray:
    pink = _pink_noise(DURATION) * 0.3
    t = np.arange(int(SR * DURATION)) / SR
    hum = 4000 * np.sin(2 * math.pi * 120 * t)
    return pink + hum


def _airport() -> np.ndarray:
    pink = _pink_noise(DURATION) * 0.8
    burst = np.zeros(int(SR * DURATION))
    for _ in range(3):
        start = np.random.randint(0, len(burst) - 500)
        burst[start : start + 500] += np.random.randn(500) * 3000
    return pink + burst


def _babble() -> np.ndarray:
    pink = _pink_noise(DURATION)
    t = np.arange(int(SR * DURATION)) / SR
    modulator = 0.5 + 0.5 * np.sin(2 * math.pi * 4 * t)
    return pink * modulator * 1.5


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "scenario" / "voice" / "assets" / "noise"
    out.mkdir(parents=True, exist_ok=True)
    _save(out / "cafe.wav", _cafe())
    _save(out / "street.wav", _street())
    _save(out / "office.wav", _office())
    _save(out / "airport.wav", _airport())
    _save(out / "babble.wav", _babble())
    print(f"Wrote 5 samples to {out}")


if __name__ == "__main__":
    main()
