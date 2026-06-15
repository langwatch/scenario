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
    content: Union[str, bytes, Path] = "",
    *,
    after_words: Optional[int] = None,
    wait_for_speech_timeout: float = 8.0,
) -> ScriptStep:
    """
    Declarative interruption step.

    Equivalent to ``agent(wait=False) + (bounded wait) + user(content)``:
    the agent starts replying in the background; the step waits up to
    ``wait_for_speech_timeout`` seconds for the agent to actually start
    producing audio; then the user audio is sent so the barge-in lands
    mid-utterance.

    The bounded wait matters most on transports without a client-side
    cancel signal (EL ConvAI, Gemini Live), where the interrupt must
    overlap real agent audio for the server's VAD to fire. Without it,
    user TTS finishes generating in ~600ms while the model still hasn't
    started speaking — the "interrupt" lands during silence and
    transports nothing for the bot to barge against.

    On transports with a native cancel (Twilio ``clear``, OpenAI
    Realtime ``response.cancel``), waiting for speech is harmless: the
    cancel still fires deterministically once we hit
    ``executor.user``.

    Path selection happens in ``executor.user()`` based on
    ``adapter.capabilities.interruption``:

      - ``True`` → ``adapter.interrupt()`` sends the transport-native
        interrupt. Deterministic.
      - ``False`` → user audio overlaps with the agent's TTS on the wire
        and the SUT's VAD detects barge-in.

    ``after_words`` (optional): instead of interrupting at first chunk,
    wait until the agent's streaming transcript has emitted N words.
    Requires ``capabilities.streaming_transcripts``; raises
    ``UnsupportedCapabilityError`` otherwise.

    ``content`` routing:
        - str that does NOT end with an audio extension: treated as user text
          (routed through TTS / user simulator).
        - str that ends with .wav/.mp3/.ogg/.flac, bytes, or Path: treated as
          audio and injected via ``scenario.audio(...)``.
    """
    async def _step(state: "ScenarioState") -> None:
        executor = state._executor

        # Start the agent turn in the background.
        await executor.agent(wait=False)

        # Optional after_words gating — replaces the default "wait for
        # first audio chunk" with "wait for N transcript words."
        if after_words is not None:
            await _wait_for_streaming_words(state, after_words)
        else:
            # Bounded wait for the agent to start speaking. Cap at
            # wait_for_speech_timeout so a hung bot doesn't stall the
            # script forever, but give server-VAD adapters enough time
            # to start producing real audio against which our barge-in
            # can register.
            await _wait_for_agent_speaking(
                state, timeout=wait_for_speech_timeout
            )

        # The actual interrupt happens inside executor.user() / scenario.audio()
        # — both call into the executor, which detects the pending agent task,
        # fires adapter.interrupt() if supported, and sends the new user
        # content.
        if _is_audio_content(content):
            await audio(content)(state)  # type: ignore[arg-type]
        else:
            await executor.user(content if content else None)  # type: ignore[arg-type]

    if after_words is not None:
        _step._requires_streaming_transcripts = True  # type: ignore[attr-defined]
    return _step


async def _wait_for_agent_speaking(state: "ScenarioState", timeout: float) -> None:
    """Wait up to ``timeout`` seconds for the active voice adapter's
    ``_agent_speaking_event`` to set. Returns silently on timeout —
    callers proceed with the interrupt regardless so a hung or silent
    bot doesn't block the script forever.
    """
    adapter = _voice_adapter(state)
    if adapter is None:
        return
    speaking = getattr(adapter, "_agent_speaking_event", None)
    if speaking is None or speaking.is_set():
        return
    try:
        await asyncio.wait_for(speaking.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        return


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
                "Use interrupt(content) without after_words on this adapter — "
                "the executor fires barge-in at the agent's first audio chunk."
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
    # -protocol_whitelist file,pipe — defence in depth. The bytes-input
    # path accepts caller-supplied container bytes; without this, a
    # crafted file with embedded URL data refs could steer ffmpeg into
    # an HTTP/RTSP demuxer. URL-like strings are already rejected above
    # for the path-input case; this hardens the bytes path symmetrically.
    cmd = [
        ffmpeg,
        "-protocol_whitelist", "file,pipe",
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
    # numpy is deferred to here so callers that never hit the fallback (every
    # transport adapter that ships send_dtmf — Twilio, Pipecat, ElevenLabs,
    # OpenAI Realtime) don't pay the import cost on `from scenario.voice
    # import script_steps`.
    import numpy as np

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
