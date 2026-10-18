"""Admit inbound Twilio speech while leaving quiet gaps for turn detection."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

from ..audio_chunk import AudioChunk


@dataclass(frozen=True)
class TwilioSpeechGateOptions:
    """Inbound speech gate settings, matching the JavaScript adapter.

    Attributes:
        rms_threshold: Speech threshold on the PCM16 amplitude scale.
        hangover_ms: Quiet audio retained after speech, in milliseconds.
        preroll_ms: Quiet audio retained before a speech onset, in milliseconds.
    """

    rms_threshold: float = 800
    hangover_ms: float = 400
    preroll_ms: float = 300


class TwilioSpeechGate:
    """Bounded pre-roll and hangover around energy-detected speech."""

    def __init__(self, options: TwilioSpeechGateOptions | None = None) -> None:
        self._options = options if options is not None else TwilioSpeechGateOptions()
        self.dropped_chunks = 0
        self.dropped_ms = 0.0
        self.onsets = 0
        self.reset()

    def reset(self) -> None:
        """Clear per-call audio state, retaining connection-lifetime counters."""
        self._speaking = False
        self._silent_ms = 0.0
        self._preroll: deque[AudioChunk] = deque()
        self._preroll_held_ms = 0.0

    def reset_counters(self) -> None:
        """Start a fresh connection with no held audio or counters."""
        self.reset()
        self.dropped_chunks = 0
        self.dropped_ms = 0.0
        self.onsets = 0

    def admit(self, chunk: AudioChunk) -> list[AudioChunk]:
        """Return the admitted chunk, onset pre-roll, or no audio during silence."""
        if not chunk.data:
            self.reset()
            return [chunk]
        chunk_ms = chunk.duration_seconds * 1000
        samples = np.frombuffer(chunk.data, dtype="<i2").astype(np.float64)
        rms = float(np.sqrt(np.mean(samples * samples)))
        is_speech = rms >= self._options.rms_threshold
        if self._speaking:
            if is_speech:
                self._silent_ms = 0.0
                return [chunk]
            self._silent_ms += chunk_ms
            if self._silent_ms <= self._options.hangover_ms:
                return [chunk]
            self._speaking = False
            self._silent_ms = 0.0
            self._hold(chunk, chunk_ms)
            return []
        if not is_speech:
            self._hold(chunk, chunk_ms)
            return []
        self._speaking = True
        self._silent_ms = 0.0
        self.onsets += 1
        admitted = [*self._preroll, chunk]
        self.dropped_chunks -= len(self._preroll)
        self.dropped_ms -= self._preroll_held_ms
        self._preroll.clear()
        self._preroll_held_ms = 0.0
        return admitted

    def _hold(self, chunk: AudioChunk, chunk_ms: float) -> None:
        self.dropped_chunks += 1
        self.dropped_ms += chunk_ms
        self._preroll.append(chunk)
        self._preroll_held_ms += chunk_ms
        while self._preroll and self._preroll_held_ms > self._options.preroll_ms:
            self._preroll_held_ms -= self._preroll.popleft().duration_seconds * 1000
