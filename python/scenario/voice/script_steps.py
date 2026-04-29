"""
Voice-specific script steps: sleep, silence, audio, dtmf, interrupt.

These compose with the existing scenario.user / scenario.agent / scenario.judge
steps — no separate paradigm.

Phase 1 lands: sleep, silence, audio.
Phase 3 lands: dtmf, interrupt, and the ``agent(wait=False)`` async primitive.
"""

from __future__ import annotations

import asyncio
import math
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Union

import numpy as np

from ..types import ScriptStep
from .audio_chunk import AudioChunk, silent_chunk
from .capabilities import UnsupportedCapabilityError
from .messages import create_audio_message

if TYPE_CHECKING:
    from ..scenario_state import ScenarioState


_URL_LIKE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+\-.]*://")


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
        await adapter.send_audio(silent_chunk(duration))

    return _step


def audio(path_or_bytes: Union[str, Path, bytes]) -> ScriptStep:
    """
    Inject a pre-recorded audio file (WAV/MP3/OGG/FLAC) or raw bytes as the
    user's next turn. Bypasses the user simulator and TTS entirely.

    Files are auto-converted to PCM16 @ 24kHz mono via the bundled ffmpeg.
    Remote URL-like strings (``http://``, ``rtmp://``, etc.) are rejected to
    prevent ffmpeg from issuing outbound network requests on the user's behalf.
    """

    async def _step(state: "ScenarioState") -> None:
        chunk = await asyncio.to_thread(_load_audio_to_chunk, path_or_bytes)
        adapter = _voice_adapter(state)
        if adapter is None:
            state.messages.append(create_audio_message(chunk, role="user"))  # type: ignore[arg-type]
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

    Two execution paths:

    1. **Signal-based** (preferred): when the adapter advertises
       ``capabilities.interruption=True``, the step calls
       ``adapter.interrupt()`` to send the transport-native interrupt
       (Twilio ``clear``, OpenAI Realtime ``response.cancel``, etc.). The
       SUT stops generating audio immediately — deterministic, matches
       what production code uses.

    2. **Timing-based fallback** (legacy): when the adapter has no native
       interrupt, the step composes ``agent(wait=False) + sleep(after) +
       user(content)``. The user audio overlaps with the agent's TTS on
       the wire and the SUT's VAD detects it (barge-in). Less
       deterministic — depends on VAD detection windows and exact timing.

    Either way the timing knob (``after`` seconds, or ``after_words=N`` once
    the agent has emitted N words) controls when the interrupt fires
    relative to the start of the agent's turn.

    ``content`` routing:
        - str that does NOT end with an audio extension: treated as user text
          (routed through TTS / user simulator).
        - str that ends with .wav/.mp3/.ogg/.flac, bytes, or Path: treated as
          audio and injected via ``scenario.audio(...)``.
    """
    _validate_interrupt_args(after, after_words)

    async def _step(state: "ScenarioState") -> None:
        executor = state._executor
        adapter = _voice_adapter(state)
        signal_capable = adapter is not None and adapter.capabilities.interruption

        # Start the agent turn in the background (wait=False semantics).
        await executor.agent(wait=False)

        if after_words is not None:
            await _wait_for_streaming_words(state, after_words)
        else:
            assert after is not None
            await asyncio.sleep(after)

        if signal_capable:
            # Signal path: tell the SUT to stop, cancel the pending agent
            # task (it'll never produce a complete response), then send the
            # new user input. Cleaner than racing VAD against a sleep.
            assert adapter is not None
            await adapter.interrupt()
            pending = getattr(executor, "_pending_agent_task", None)
            if pending is not None and not pending.done():
                pending.cancel()
                try:
                    await pending
                except (asyncio.CancelledError, Exception):
                    pass
                executor._pending_agent_task = None

        if _is_audio_content(content):
            await audio(content)(state)  # type: ignore[arg-type]
        else:
            await executor.user(content if content else None)  # type: ignore[arg-type]

    return _step


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
                name, "dtmf", hint="Use a telephony adapter such as TwilioAgentAdapter."
            )
        if hasattr(adapter, "send_dtmf"):
            await adapter.send_dtmf(tones)  # type: ignore[attr-defined]
        else:  # pragma: no cover — subclasses should implement send_dtmf
            await adapter.send_audio(_dtmf_to_pcm(tones))

    return _step


# ----------------------------------------------------------------- helpers


def _validate_interrupt_args(after: Optional[float], after_words: Optional[int]) -> None:
    """Enforce that exactly one of after / after_words is provided."""
    provided = [x for x in (after, after_words) if x is not None]
    if len(provided) == 0:
        raise ValueError("interrupt() requires after=seconds or after_words=N")
    if len(provided) > 1:
        raise ValueError("interrupt() takes after OR after_words, not both")


def _is_audio_content(content: Union[str, bytes, Path]) -> bool:
    """True when content should be routed through scenario.audio()."""
    if isinstance(content, (bytes, bytearray, Path)):
        return True
    if isinstance(content, str):
        return content.lower().endswith((".wav", ".mp3", ".ogg", ".flac"))
    return False


async def _wait_for_streaming_words(state: "ScenarioState", target_words: int) -> None:
    """Raise on capability miss, else poll adapter.streaming_transcript."""
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
    while True:
        transcript = getattr(adapter, "streaming_transcript", "") or ""
        if len(transcript.split()) >= target_words:
            return
        await asyncio.sleep(0.05)


def _voice_adapter(state: "ScenarioState"):
    """Find the first VoiceAgentAdapter on the scenario's executor, if any."""
    from .adapter import VoiceAgentAdapter

    executor = getattr(state, "_executor", None)
    if executor is None:
        return None
    for agent in getattr(executor, "agents", []) or []:
        if isinstance(agent, VoiceAgentAdapter):
            return agent
    return None


def _load_audio_to_chunk(path_or_bytes: Union[str, Path, bytes]) -> AudioChunk:
    """Load an audio file or raw bytes and normalise to PCM16 @ 24kHz mono.

    Rejects URL-like strings (``http://``, ``rtmp://``, etc.) so ffmpeg never
    makes outbound network requests on the caller's behalf.
    """
    import imageio_ffmpeg

    if isinstance(path_or_bytes, (bytes, bytearray)):
        source_args = ["-i", "pipe:0"]
        stdin_input: Optional[bytes] = bytes(path_or_bytes)
    else:
        path_str = str(path_or_bytes)
        if isinstance(path_or_bytes, str) and _URL_LIKE.match(path_str):
            raise ValueError(
                f"scenario.audio() refuses URL-like input {path_str!r}; "
                "download the asset locally and pass a Path instead."
            )
        p = Path(path_str).resolve()
        if not p.exists():
            raise FileNotFoundError(f"scenario.audio(): file not found: {p}")
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


_DTMF_ROW_HZ = {"1": 697, "2": 697, "3": 697, "4": 770, "5": 770, "6": 770,
                "7": 852, "8": 852, "9": 852, "*": 941, "0": 941, "#": 941}
_DTMF_COL_HZ = {"1": 1209, "2": 1336, "3": 1477, "4": 1209, "5": 1336, "6": 1477,
                "7": 1209, "8": 1336, "9": 1477, "*": 1209, "0": 1336, "#": 1477}


def _dtmf_to_pcm(tones: str, sr: int = 24000, dur_s: float = 0.1, gap_s: float = 0.05) -> AudioChunk:
    """Fallback DTMF generator (used only when adapter has no send_dtmf)."""
    n_tone = int(sr * dur_s)
    n_gap = int(sr * gap_s)
    t = np.arange(n_tone) / sr
    samples: list[np.ndarray] = []
    for ch in tones:
        if ch not in _DTMF_ROW_HZ:
            continue
        wave = 0.5 * (
            np.sin(2 * math.pi * _DTMF_ROW_HZ[ch] * t)
            + np.sin(2 * math.pi * _DTMF_COL_HZ[ch] * t)
        )
        samples.append((wave * 32767).astype(np.int16))
        samples.append(np.zeros(n_gap, dtype=np.int16))
    if not samples:
        return AudioChunk(data=b"")
    return AudioChunk(data=np.concatenate(samples).tobytes())
