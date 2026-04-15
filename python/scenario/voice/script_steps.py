"""
Voice-specific script steps: sleep, silence, audio, dtmf, interrupt.

These compose with the existing scenario.user / scenario.agent / scenario.judge
steps — no separate paradigm.

Phase 1 lands: sleep, silence, audio.
Phase 3 lands: dtmf, interrupt, and the ``agent(wait=False)`` async primitive.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Union

from ..types import ScriptStep
from .audio_chunk import AudioChunk, silent_chunk
from .capabilities import UnsupportedCapabilityError

if TYPE_CHECKING:
    from ..scenario_state import ScenarioState


def sleep(seconds: float) -> ScriptStep:
    """
    Pause the script for ``seconds`` wall-clock seconds.

    Does NOT transmit audio to the transport — this is purely a pause in the
    script timeline, useful for waiting during an async agent turn or for
    timing interruptions. If you want to send silent audio, use ``silence()``.
    """

    async def _step(state: "ScenarioState") -> None:
        await asyncio.sleep(seconds)

    return _step


def silence(duration: float) -> ScriptStep:
    """
    Actively send ``duration`` seconds of silent PCM16 audio to the agent.

    Differs from ``sleep()``: the transport sees a connected-but-silent user.
    Useful for testing how the agent handles silence (prompting, escalation).
    """

    async def _step(state: "ScenarioState") -> None:
        adapter = _voice_adapter(state)
        if adapter is None:
            # No voice adapter → behave like sleep.
            await asyncio.sleep(duration)
            return
        chunk = silent_chunk(duration)
        await adapter.send_audio(chunk)

    return _step


def audio(path_or_bytes: Union[str, Path, bytes]) -> ScriptStep:
    """
    Inject a pre-recorded audio file (WAV/MP3/OGG/FLAC) or raw bytes as the
    user's next turn. Bypasses the user simulator and TTS entirely.

    Files are auto-converted to PCM16 @ 24kHz mono via the bundled ffmpeg.
    """

    async def _step(state: "ScenarioState") -> None:
        chunk = _load_audio_to_chunk(path_or_bytes)
        adapter = _voice_adapter(state)
        if adapter is None:
            # Fallback: add as a multimodal user message.
            from .messages import create_audio_message

            state.messages.append(create_audio_message(chunk, role="user"))
            return
        await adapter.send_audio(chunk)

    return _step


def interrupt(
    *,
    after: Optional[float] = None,
    after_words: Optional[int] = None,
    content: Union[str, bytes, Path] = "",
) -> ScriptStep:
    """
    Declarative interruption step (§4.4 L450-492).

    Equivalent to: ``agent(wait=False) + sleep(after) + user(content)``, with
    the added option of triggering the interruption after the agent has
    emitted ``after_words`` words (requires streaming transcripts — raises
    UnsupportedCapabilityError on adapters that don't advertise it, per the
    after_words UnsupportedCapabilityError locked decision).

    ``content`` may be:
        - str: treated as user text (routed through TTS / user simulator).
        - bytes or Path: treated as audio (same as ``scenario.audio(...)``).
    """
    if after is None and after_words is None:
        raise ValueError("interrupt() requires after=seconds or after_words=N")
    if after is not None and after_words is not None:
        raise ValueError("interrupt() takes after OR after_words, not both")

    async def _step(state: "ScenarioState") -> None:
        import asyncio

        executor = state._executor
        # Start the agent turn in the background (wait=False semantics).
        await executor.agent(wait=False)

        if after_words is not None:
            adapter = _voice_adapter(state)
            name = type(adapter).__name__ if adapter else "<no voice adapter>"
            if adapter is None or not adapter.capabilities.streaming_transcripts:
                raise UnsupportedCapabilityError(
                    name,
                    "streaming_transcripts",
                    hint=(
                        "interrupt(after_words=N) needs incremental transcripts. "
                        "Use interrupt(after=seconds) instead on this adapter."
                    ),
                )
            await _wait_for_word_count(adapter, after_words)
        else:
            assert after is not None
            await asyncio.sleep(after)

        # Deliver the interruption.
        if isinstance(content, (bytes, Path)) or (isinstance(content, str) and _looks_like_audio_path(content)):
            await audio(content)(state)
        else:
            await executor.user(content if content else None)

    return _step


async def _wait_for_word_count(adapter, target_words: int) -> None:
    """Block until the adapter's streaming transcript reaches ``target_words`` words."""
    import asyncio

    while True:
        transcript = getattr(adapter, "streaming_transcript", "") or ""
        if len(transcript.split()) >= target_words:
            return
        await asyncio.sleep(0.05)


def _looks_like_audio_path(s: str) -> bool:
    lower = s.lower()
    return lower.endswith((".wav", ".mp3", ".ogg", ".flac"))


def dtmf(tones: str) -> ScriptStep:
    """
    Emit DTMF tones (telephony-only). Raises UnsupportedCapabilityError if
    the active adapter does not advertise ``capabilities.dtmf``.
    """

    async def _step(state: "ScenarioState") -> None:
        adapter = _voice_adapter(state)
        name = type(adapter).__name__ if adapter else "<no voice adapter>"
        if adapter is None or not adapter.capabilities.dtmf:
            raise UnsupportedCapabilityError(
                name, "dtmf", hint="Use a telephony adapter such as TwilioAgent."
            )
        # Delegate to the adapter if it provides a send_dtmf method; otherwise
        # fall back to generating DTMF PCM tones and sending them as audio.
        if hasattr(adapter, "send_dtmf"):
            await adapter.send_dtmf(tones)  # type: ignore[attr-defined]
        else:  # pragma: no cover — subclasses should implement send_dtmf
            chunk = _dtmf_to_pcm(tones)
            await adapter.send_audio(chunk)

    return _step


# ----------------------------------------------------------------- helpers


def _voice_adapter(state: "ScenarioState"):
    """Find the first VoiceAgentAdapter in the scenario's agent list, if any."""
    from .adapter import VoiceAgentAdapter

    for agent in getattr(state, "agents", []) or []:
        if isinstance(agent, VoiceAgentAdapter):
            return agent
    executor = getattr(state, "_executor", None)
    if executor is not None:
        for agent in getattr(executor, "agents", []) or []:
            if isinstance(agent, VoiceAgentAdapter):
                return agent
    return None


def _load_audio_to_chunk(path_or_bytes: Union[str, Path, bytes]) -> AudioChunk:
    """Load an audio file or raw bytes and normalise to PCM16 @ 24kHz mono."""
    import subprocess

    import imageio_ffmpeg

    if isinstance(path_or_bytes, (bytes, bytearray)):
        raw_bytes = bytes(path_or_bytes)
        source_args = ["-i", "pipe:0"]
        stdin_input: Optional[bytes] = raw_bytes
    else:
        p = Path(path_or_bytes)
        source_args = ["-i", str(p)]
        stdin_input = None

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg,
        "-loglevel", "error",
        "-y",
        *source_args,
        "-f", "s16le",
        "-ac", "1",
        "-ar", "24000",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, input=stdin_input, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed to decode audio: {proc.stderr.decode(errors='replace')}"
        )
    return AudioChunk(data=proc.stdout)


def _dtmf_to_pcm(tones: str) -> AudioChunk:
    """Fallback DTMF generator (used only when adapter has no send_dtmf)."""
    import math

    import numpy as np

    # Standard DTMF frequencies (Hz)
    rows = {"1": 697, "2": 697, "3": 697, "4": 770, "5": 770, "6": 770,
            "7": 852, "8": 852, "9": 852, "*": 941, "0": 941, "#": 941}
    cols = {"1": 1209, "2": 1336, "3": 1477, "4": 1209, "5": 1336, "6": 1477,
            "7": 1209, "8": 1336, "9": 1477, "*": 1209, "0": 1336, "#": 1477}
    sr = 24000
    dur_s = 0.1
    gap_s = 0.05
    samples = []
    n_tone = int(sr * dur_s)
    n_gap = int(sr * gap_s)
    t = np.arange(n_tone) / sr
    for ch in tones:
        if ch not in rows:
            continue
        wave = 0.5 * (np.sin(2 * math.pi * rows[ch] * t) + np.sin(2 * math.pi * cols[ch] * t))
        samples.append((wave * 32767).astype(np.int16))
        samples.append(np.zeros(n_gap, dtype=np.int16))
    if not samples:
        return AudioChunk(data=b"")
    joined = np.concatenate(samples)
    return AudioChunk(data=joined.tobytes())
