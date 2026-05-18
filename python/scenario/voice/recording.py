"""
Voice recording, timeline events, and latency metrics.

These are the output-side types (§4.6 of the proposal). Each scenario.run()
that uses a voice adapter produces a VoiceRecording + timeline + latency
metrics attached to the ScenarioResult.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Literal, Optional, Union

from .audio_chunk import PCM16_SAMPLE_RATE, PCM16_CHANNELS


SpeakerRole = Literal["user", "agent"]


@dataclass
class AudioSegment:
    """A contiguous span of audio attributed to one speaker.

    ``transcript_truncated`` is True when this agent segment was cut short
    by a user_interrupt event during the run — the audio bytes are
    authoritative; the transcript may reflect what the agent INTENDED to
    say, not what the user actually heard. Tools that care about wire
    truth should re-transcribe the audio (transcribe_segments with
    ``only_missing=False``) on truncated segments.
    """

    speaker: SpeakerRole
    start_time: float
    end_time: float
    audio: bytes  # PCM16 bytes
    transcript: Optional[str] = None
    transcript_truncated: bool = False


@dataclass
class VoiceEvent:
    """
    One timestamped event on the voice conversation timeline.

    Types (from §4.6 L600-615):
        user_start_speaking, user_stop_speaking, agent_start_speaking,
        agent_stop_speaking, tool_call, tool_result, user_interrupt.

    `latency` is populated for ``agent_start_speaking`` events and measures
    the response time from the preceding user_stop_speaking event.

    `metadata` is a free-form dict for type-specific context. Examples:
        - user_interrupt: {"adapter": "PipecatAgentAdapter", "native": True}
        - tool_call:      {"call_id": "..."}
    """

    time: float
    type: str
    name: Optional[str] = None
    args: Optional[Dict[str, Any]] = None
    result: Optional[Any] = None
    latency: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None


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

    ``timeline`` mirrors result.timeline so save_segments() can write
    timestamped events (user_interrupt, etc.) into the manifest. Populated
    by the executor at end-of-scenario via _attach_voice_output.
    """

    segments: List[AudioSegment] = field(default_factory=list)
    timeline: List["VoiceEvent"] = field(default_factory=list)

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

    _ALLOWED_FORMATS = frozenset({"wav", "mp3", "ogg", "flac"})

    def save(self, path: Union[str, Path], format: Optional[str] = None) -> Path:
        """
        Save the conversation audio to a file.

        By default the format is inferred from the path suffix. ``format="mp3"``
        (or any non-wav format) uses the bundled ffmpeg binary via imageio-ffmpeg
        to transcode from the internal WAV representation.

        Security: ``path`` is resolved (``Path.resolve()``) before writing, and
        ``format`` is validated against an allowlist of supported formats. This
        prevents passing arbitrary ffmpeg muxer names or relying on ambiguous
        path semantics.
        """
        resolved = Path(path).resolve()
        fmt = (format or resolved.suffix.lstrip(".")).lower() or "wav"
        if fmt not in self._ALLOWED_FORMATS:
            raise ValueError(
                f"save(format={fmt!r}) not supported; allowed: "
                f"{sorted(self._ALLOWED_FORMATS)}"
            )
        wav_bytes = self.full_wav
        if fmt == "wav":
            resolved.write_bytes(wav_bytes)
            return resolved

        import subprocess

        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        # -protocol_whitelist file,pipe — defence in depth. Input here is
        # our own WAV bytes (not user-controlled), but the whitelist costs
        # nothing and forecloses future regressions if a caller pipes in
        # externally sourced container bytes through this path.
        proc = subprocess.run(
            [
                ffmpeg,
                "-protocol_whitelist", "file,pipe",
                "-loglevel", "error",
                "-y",
                "-f", "wav",
                "-i", "pipe:0",
                "-f", fmt,
                str(resolved),
            ],
            input=wav_bytes,
            capture_output=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg transcode to {fmt!r} failed: {proc.stderr.decode(errors='replace')}"
            )
        return resolved

    def save_segments(self, dir: Union[str, Path], manifest: bool = True) -> Path:
        """
        Write each segment as its own WAV file plus the full mixed conversation,
        optionally with a JSON manifest pairing files to transcripts/timestamps.

        Layout::

            <dir>/
                segments/
                    00-user-0000ms.wav
                    01-agent-0312ms.wav
                    ...
                full.wav
                manifest.json   # iff manifest=True

        Segment file names: zero-padded index, role, start_time in ms.
        Manifest schema::

            {
              "generated_at": "<ISO 8601 UTC>",
              "duration": <float seconds>,
              "segment_count": <int>,
              "segments": [
                {"idx": 0, "file": "segments/00-user-0000ms.wav",
                 "role": "user", "start_time": 0.0, "end_time": 1.2,
                 "duration": 1.2, "transcript": "..."}
              ]
            }

        The directory is created (parents=True, exist_ok=True). Existing
        contents in the target directory are NOT cleared — caller decides
        retention.  Returns the resolved directory path.
        """
        from io import BytesIO
        import wave

        target = Path(dir).resolve()
        segments_dir = target / "segments"
        target.mkdir(parents=True, exist_ok=True)
        segments_dir.mkdir(parents=True, exist_ok=True)

        ordered = sorted(self.segments, key=lambda s: s.start_time)
        segment_entries: List[Dict[str, Any]] = []

        for idx, seg in enumerate(ordered):
            start_ms = int(seg.start_time * 1000)
            filename = f"{idx:02d}-{seg.speaker}-{start_ms:04d}ms.wav"
            seg_path = segments_dir / filename

            buf = BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(PCM16_CHANNELS)
                w.setsampwidth(2)
                w.setframerate(PCM16_SAMPLE_RATE)
                w.writeframes(seg.audio)
            seg_path.write_bytes(buf.getvalue())

            rel_file = f"segments/{filename}"
            entry: Dict[str, Any] = {
                "idx": idx,
                "file": rel_file,
                "role": seg.speaker,
                "start_time": seg.start_time,
                "end_time": seg.end_time,
                "duration": seg.end_time - seg.start_time,
                "transcript": seg.transcript,
            }
            if seg.transcript_truncated:
                entry["transcript_truncated"] = True
            segment_entries.append(entry)

        # Write the full mixed WAV.
        (target / "full.wav").write_bytes(self.full_wav)

        if manifest:
            event_entries: List[Dict[str, Any]] = []
            for evt in sorted(self.timeline, key=lambda e: e.time):
                entry: Dict[str, Any] = {"time": evt.time, "type": evt.type}
                if evt.latency is not None:
                    entry["latency"] = evt.latency
                if evt.name is not None:
                    entry["name"] = evt.name
                if evt.args is not None:
                    entry["args"] = evt.args
                if evt.result is not None:
                    entry["result"] = evt.result
                if evt.metadata is not None:
                    entry["metadata"] = evt.metadata
                event_entries.append(entry)
            manifest_data: Dict[str, Any] = {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration": self.duration,
                "segment_count": len(ordered),
                "segments": segment_entries,
                "events": event_entries,
            }
            (target / "manifest.json").write_text(
                json.dumps(manifest_data, indent=2), encoding="utf-8"
            )

        return target
