"""
Voice recording, timeline events, and latency metrics.

These are the output-side types (§4.6 of the proposal). Each scenario.run()
that uses a voice adapter produces a VoiceRecording + timeline + latency
metrics attached to the ScenarioResult.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Literal, Optional, Union

from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE, PCM16_CHANNELS


SpeakerRole = Literal["user", "agent"]


@dataclass
class AudioSegment:
    """A contiguous span of audio attributed to one speaker."""

    speaker: SpeakerRole
    start_time: float
    end_time: float
    audio: bytes  # PCM16 bytes
    transcript: Optional[str] = None


@dataclass
class VoiceEvent:
    """
    One timestamped event on the voice conversation timeline.

    Types (from §4.6 L600-615):
        user_start_speaking, user_stop_speaking, agent_start_speaking,
        agent_stop_speaking, tool_call, tool_result, user_interrupt.

    `latency` is populated for ``agent_start_speaking`` events and measures
    the response time from the preceding user_stop_speaking event.
    """

    time: float
    type: str
    name: Optional[str] = None
    args: Optional[Dict[str, Any]] = None
    result: Optional[Any] = None
    latency: Optional[float] = None


@dataclass
class LatencyMetrics:
    """Summary of agent response timing across the conversation."""

    measurements: List[float] = field(default_factory=list)
    time_to_first_byte: Optional[float] = None
    interrupt_response_time: Optional[float] = None

    @property
    def avg_response_time(self) -> Optional[float]:
        if not self.measurements:
            return None
        return sum(self.measurements) / len(self.measurements)

    @property
    def p50_response_time(self) -> Optional[float]:
        if not self.measurements:
            return None
        return median(self.measurements)

    @property
    def p95_response_time(self) -> Optional[float]:
        if not self.measurements:
            return None
        import math
        sorted_ms = sorted(self.measurements)
        # Ceiling-style: round up so p95 reflects the tail, not the body.
        idx = min(len(sorted_ms) - 1, math.ceil(0.95 * (len(sorted_ms) - 1)))
        return sorted_ms[idx]


@dataclass
class VoiceRecording:
    """
    The full audio record of a voice scenario, segmented by speaker.

    Usage (§4.6):
        result.audio.save("conversation.wav")
        result.audio.save("conversation.mp3", format="mp3")
        for seg in result.audio.segments: ...
    """

    segments: List[AudioSegment] = field(default_factory=list)

    @property
    def duration(self) -> float:
        if not self.segments:
            return 0.0
        return max(s.end_time for s in self.segments)

    @property
    def full_wav(self) -> bytes:
        """Full mixed/concatenated conversation audio as a WAV byte string."""
        from io import BytesIO
        import wave

        buf = BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(PCM16_CHANNELS)
            w.setsampwidth(2)
            w.setframerate(PCM16_SAMPLE_RATE)
            for seg in sorted(self.segments, key=lambda s: s.start_time):
                w.writeframes(seg.audio)
        return buf.getvalue()

    def save(self, path: Union[str, Path], format: Optional[str] = None) -> Path:
        """
        Save the conversation audio to a file.

        By default the format is inferred from the path suffix. ``format="mp3"``
        (or any non-wav format) uses the bundled ffmpeg binary via imageio-ffmpeg
        to transcode from the internal WAV representation.
        """
        path = Path(path)
        fmt = (format or path.suffix.lstrip(".")).lower() or "wav"
        wav_bytes = self.full_wav
        if fmt == "wav":
            path.write_bytes(wav_bytes)
            return path

        # Transcode via bundled ffmpeg.
        import subprocess
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        proc = subprocess.run(
            [
                ffmpeg,
                "-loglevel", "error",
                "-y",
                "-f", "wav",
                "-i", "pipe:0",
                "-f", fmt,
                str(path),
            ],
            input=wav_bytes,
            capture_output=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg transcode to {fmt!r} failed: {proc.stderr.decode(errors='replace')}"
            )
        return path
