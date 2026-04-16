"""
AudioChunk — the canonical internal audio representation.

Per the AudioChunk normalization locked decision: every piece of audio flowing
through the SDK is PCM16 @ 24kHz mono at the framework boundary. Adapters
convert to/from their transport-native format at the send/recv edge.

This keeps the combinatorial complexity of N adapters x M formats collapsed to
N conversions at the adapter edge.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


PCM16_SAMPLE_RATE = 24000
PCM16_CHANNELS = 1
PCM16_SAMPLE_WIDTH_BYTES = 2  # 16-bit


@dataclass
class AudioChunk:
    """
    A chunk of audio in the canonical internal format: PCM16, 24kHz, mono.

    Attributes:
        data: Raw PCM16 little-endian bytes, mono, sample rate = 24000 Hz.
        transcript: Optional transcript text (may be populated by streaming STT).
        start_time: Optional wall-clock offset from scenario start, in seconds.
        end_time: Optional wall-clock offset from scenario start, in seconds.
    """

    data: bytes
    transcript: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None

    def __post_init__(self) -> None:
        # PCM16 samples are 2 bytes each. An odd-length buffer means a WebSocket
        # framing boundary split a sample — downstream code (np.frombuffer,
        # duration_seconds) silently truncates and produces off-by-one drift.
        # Catch it at the canonical boundary instead.
        if len(self.data) % PCM16_SAMPLE_WIDTH_BYTES != 0:
            raise ValueError(
                f"AudioChunk.data length ({len(self.data)} bytes) is not a "
                f"multiple of {PCM16_SAMPLE_WIDTH_BYTES} — not valid PCM16. "
                "This usually indicates a partial transport frame; adapters "
                "must buffer until a complete sample is available."
            )

    @property
    def sample_rate(self) -> int:
        return PCM16_SAMPLE_RATE

    @property
    def channels(self) -> int:
        return PCM16_CHANNELS

    @property
    def duration_seconds(self) -> float:
        """Length of the chunk in seconds (from bytes, assuming PCM16 mono)."""
        if not self.data:
            return 0.0
        num_samples = len(self.data) // PCM16_SAMPLE_WIDTH_BYTES
        return num_samples / PCM16_SAMPLE_RATE


def silent_chunk(duration_seconds: float) -> AudioChunk:
    """Generate a PCM16 silent AudioChunk of the given duration."""
    num_samples = int(duration_seconds * PCM16_SAMPLE_RATE)
    return AudioChunk(data=b"\x00\x00" * num_samples)
