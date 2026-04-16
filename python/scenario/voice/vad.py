"""
Voice-activity detection fallback for adapters without native VAD.

Planning-level addition — the source proposal assumes the adapter emits
speaking-start/stop events. Pipecat, LiveKit, OpenAI Realtime do; Twilio
Media Streams does not. When ``adapter.capabilities.native_vad`` is False,
this module runs ``webrtcvad`` on the incoming audio stream and emits the
equivalent events so the timeline is still populated.

On first activation per process, we emit a single ``UserWarning`` so users
know the fallback is in effect and accuracy may differ from native VAD.
"""

from __future__ import annotations

import warnings
from typing import Callable, Optional

from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


class WebRTCVadFallback:
    """
    Incremental VAD over PCM16 @ 24kHz mono audio.

    Feed chunks via ``process(chunk)``; the callbacks ``on_speech_start`` and
    ``on_speech_end`` fire when the speech/silence transitions stabilise.

    Aggressiveness level 0–3 (3 = most aggressive filter). Frame size 10, 20,
    or 30 ms; we use 30 ms.
    """

    FRAME_MS = 30
    SAMPLES_PER_FRAME = PCM16_SAMPLE_RATE * FRAME_MS // 1000
    BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2

    _warned_adapters: "set[str]" = set()

    @classmethod
    def reset_warnings(cls) -> None:
        """Clear the per-adapter warning memoization. Intended for tests."""
        cls._warned_adapters = set()

    @classmethod
    def _emit_fallback_warning_once(cls, adapter_name: str) -> None:
        if adapter_name in cls._warned_adapters:
            return
        cls._warned_adapters.add(adapter_name)
        warnings.warn(
            f"Adapter {adapter_name!r} has no native VAD — using SDK-side webrtcvad. "
            f"Accuracy may differ from native VAD.",
            UserWarning,
            stacklevel=3,
        )

    def __init__(
        self,
        adapter_name: str,
        aggressiveness: int = 2,
        on_speech_start: Optional[Callable[[], None]] = None,
        on_speech_end: Optional[Callable[[], None]] = None,
    ):
        self._emit_fallback_warning_once(adapter_name)
        import webrtcvad  # hard dep via webrtcvad-wheels

        self._vad = webrtcvad.Vad(aggressiveness)
        self._speaking = False
        self._buf = bytearray()
        self._on_start = on_speech_start or (lambda: None)
        self._on_end = on_speech_end or (lambda: None)
        # webrtcvad supports 8000/16000/32000/48000 Hz. 24000 is NOT supported,
        # so we downsample frames to 16kHz for classification while keeping the
        # original audio as PCM16 @ 24kHz.
        self._vad_rate = 16000

    def _resample_24k_to_16k(self, pcm24k: bytes) -> bytes:
        """Naive 24k -> 16k downsample (ratio 3:2) for VAD classification only."""
        import numpy as np

        samples = np.frombuffer(pcm24k, dtype=np.int16)
        if len(samples) == 0:
            return b""
        # Simple linear resampling: output = round(len * 2 / 3)
        new_len = max(1, int(round(len(samples) * 2 / 3)))
        idx = np.linspace(0, len(samples) - 1, new_len).astype(np.int64)
        out = samples[idx].astype(np.int16)
        return out.tobytes()

    def process(self, chunk: AudioChunk) -> None:
        """Feed audio to the detector; callbacks fire on transitions."""
        self._buf.extend(chunk.data)
        while len(self._buf) >= self.BYTES_PER_FRAME:
            frame = bytes(self._buf[: self.BYTES_PER_FRAME])
            del self._buf[: self.BYTES_PER_FRAME]
            # Resample to 16kHz for webrtcvad (24kHz not supported).
            frame_16k = self._resample_24k_to_16k(frame)
            bytes_per_frame_16k = (self._vad_rate * self.FRAME_MS // 1000) * 2
            if len(frame_16k) < bytes_per_frame_16k:
                continue
            frame_16k = frame_16k[:bytes_per_frame_16k]
            try:
                is_speech = self._vad.is_speech(frame_16k, self._vad_rate)
            except Exception:  # pragma: no cover — defensive
                is_speech = False
            if is_speech and not self._speaking:
                self._speaking = True
                self._on_start()
            elif not is_speech and self._speaking:
                self._speaking = False
                self._on_end()

    @property
    def is_speaking(self) -> bool:
        return self._speaking
