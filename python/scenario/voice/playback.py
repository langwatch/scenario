"""
Local audio playback via the bundled ffmpeg binary.

Per the ffplay playback locked decision: we use ``ffmpeg`` (which imageio-ffmpeg
DOES bundle) with a platform-appropriate audio-output driver — NOT ``ffplay``
(which imageio-ffmpeg does NOT bundle).

Degrades gracefully on headless systems: if the ffmpeg subprocess fails to
open the output device, we emit a debug log and return; the scenario run
continues normally and ``result.audio`` is still populated.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import subprocess
from typing import Optional

from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


logger = logging.getLogger("scenario.voice.playback")


def _platform_audio_output_args() -> list[str]:
    """Return the ffmpeg ``-f <driver> <device>`` pair appropriate for this OS."""
    sysname = platform.system()
    if sysname == "Darwin":
        return ["-f", "audiotoolbox", "-"]
    if sysname == "Linux":
        return ["-f", "alsa", "default"]
    if sysname == "Windows":
        return ["-f", "dshow", "audio=default"]
    # Fallback: let ffmpeg pick, which will usually fail loudly.
    return ["-f", "alsa", "default"]


class FfmpegPlayback:
    """
    Stateful playback session that spawns an ffmpeg subprocess reading PCM16
    bytes from stdin and writing to the platform audio output driver.
    """

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._active = False

    def start(self) -> None:
        try:
            import imageio_ffmpeg

            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            cmd = [
                ffmpeg,
                "-loglevel", "error",
                "-f", "s16le",
                "-ac", "1",
                "-ar", str(PCM16_SAMPLE_RATE),
                "-i", "pipe:0",
                *_platform_audio_output_args(),
            ]
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            self._active = True
        except Exception as exc:  # pragma: no cover — depends on host
            logger.debug("audio_playback: failed to start ffmpeg subprocess: %s", exc)
            self._active = False
            self._proc = None

    def feed(self, chunk: AudioChunk) -> None:
        if not self._active or self._proc is None or self._proc.stdin is None:
            return
        try:
            self._proc.stdin.write(chunk.data)
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            logger.debug("audio_playback: stream closed unexpectedly: %s", exc)
            self._active = False

    def stop(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin is not None:
                self._proc.stdin.close()
            self._proc.wait(timeout=1.0)
        except Exception:  # pragma: no cover — best-effort cleanup
            try:
                self._proc.kill()
            except Exception as exc:
                # Last-ditch kill failed (e.g. process already gone). Log
                # and continue — we still need to release self._proc.
                logger.debug("FfmpegPlayback.stop: final kill() failed: %s", exc)
        self._proc = None
        self._active = False

    @property
    def active(self) -> bool:
        return self._active


async def play_chunk(chunk: AudioChunk) -> None:
    """Play a single AudioChunk and wait for it to finish."""
    playback = FfmpegPlayback()
    playback.start()
    try:
        playback.feed(chunk)
    finally:
        await asyncio.to_thread(playback.stop)
