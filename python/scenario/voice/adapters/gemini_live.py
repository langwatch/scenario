"""
GeminiLiveAgentAdapter: direct-to-model adapter for Gemini Live native-audio.

Source §5.6.

Wire protocol (google-genai SDK):
- Connect via ``client.aio.live.connect(model=..., config=...)`` — an async
  context manager that yields an ``AsyncSession``.
- Send: ``session.send_realtime_input(audio=types.Blob(data=..., mime_type='audio/pcm;rate=16000'))``
  Gemini Live expects PCM16 mono at 16kHz. Canonical AudioChunks are 24kHz, so
  this adapter resamples 24kHz → 16kHz at the send edge and 16kHz → 24kHz at
  the receive edge.
- Receive: ``async for message in session.receive()`` yields
  ``LiveServerMessage`` objects.
  - ``message.server_content.model_turn`` — contains Parts; inline_data parts
    hold raw PCM bytes.
  - ``message.server_content.output_transcription`` — text transcript; stored
    on ``self.last_agent_transcript``.

The SDK context manager must stay open across the adapter's lifetime.  We
achieve this by spawning a background task that holds the ``async with`` block
open and exposes the ``AsyncSession`` through an ``asyncio.Future`` once the
handshake completes.

Audio sample rates:
    Canonical internal:  PCM16 mono 24000 Hz  (AudioChunk)
    Gemini Live input:   PCM16 mono 16000 Hz  (``audio/pcm;rate=16000``)
    Gemini Live output:  PCM16 mono 24000 Hz  (docs say 24kHz output)

Resampling uses numpy linear interpolation — scipy is not required.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


logger = logging.getLogger("scenario.voice.gemini_live")

# Gemini Live ingests PCM16 at 16kHz.
GEMINI_INPUT_RATE = 16000
# Gemini Live emits PCM16 at 24kHz (canonical).
GEMINI_OUTPUT_RATE = 24000
# Canonical internal rate.
CANONICAL_RATE = 24000


def _resample_pcm16(data: bytes, from_rate: int, to_rate: int) -> bytes:
    """Resample mono PCM16 little-endian bytes between two sample rates.

    Uses numpy linear interpolation — fast, no scipy dependency.
    Returns an even-length byte buffer (PCM16 invariant).
    """
    if from_rate == to_rate or not data:
        return data

    import numpy as np  # noqa: PLC0415 — lazy import keeps module-load cheap

    samples = np.frombuffer(data, dtype="<i2")
    n_out = int(len(samples) * to_rate / from_rate)
    if n_out == 0:
        return b""
    x_old = np.linspace(0, 1, len(samples))
    x_new = np.linspace(0, 1, n_out)
    resampled = np.interp(x_new, x_old, samples).astype("<i2")
    out = resampled.tobytes()
    # Enforce PCM16 invariant — must be even-length.
    if len(out) % 2 == 1:
        out = out[:-1]
    return out


class GeminiLiveAgentAdapter(VoiceAgentAdapter):
    """
    Gemini Live native-audio adapter.

    Connects directly to the Gemini Live API via the official ``google-genai``
    SDK.  STT, LLM, and TTS all run on Google's infrastructure; audio flows
    bidirectionally as raw PCM16.

    Example::

        adapter = GeminiLiveAgentAdapter(
            model="gemini-2.5-flash-preview-native-audio-dialog",
            system_instruction="You are a helpful assistant.",
        )
        async with adapter:
            # scenario.run() feeds send_audio / recv_audio ...

    Attributes:
        last_agent_transcript: Most-recent output transcript received from
            the server (if transcription is available), for observability.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/16000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(
        self,
        model: str = "gemini-2.5-flash-preview-native-audio-dialog",
        voice: str = "Algieba",
        system_instruction: str = "",
        api_key: Optional[str] = None,
    ) -> None:
        self.model = model
        self.voice = voice
        self.system_instruction = system_instruction
        # Resolve key: explicit arg > env var.
        self._api_key: str = api_key or os.environ.get("GEMINI_API_KEY", "")

        # Populated when the background session task is live.
        self._session: Optional[Any] = None
        self._session_task: Optional[asyncio.Task[None]] = None
        self._session_ready: Optional[asyncio.Event] = None
        self._shutdown: Optional[asyncio.Event] = None
        self._session_error: Optional[BaseException] = None

        # Observability.
        self.last_agent_transcript: Optional[str] = None

    def __repr__(self) -> str:
        # Never leak the API key.
        masked = "***" if self._api_key else ""
        return (
            f"GeminiLiveAgentAdapter("
            f"model={self.model!r}, "
            f"voice={self.voice!r}, "
            f"api_key={masked!r})"
        )

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Open a Gemini Live session.

        Spawns a background task that holds the ``async with`` SDK context open
        for the adapter's lifetime.  Returns once the session handshake is
        complete and audio can flow.
        """
        from google import genai  # noqa: PLC0415 — lazy import
        from google.genai import types  # noqa: PLC0415

        self._session_ready = asyncio.Event()
        self._shutdown = asyncio.Event()
        loop = asyncio.get_running_loop()
        session_future: asyncio.Future[Any] = loop.create_future()

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=self.system_instruction or None,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice,
                    )
                )
            ),
        )

        client = genai.Client(api_key=self._api_key)

        async def _session_lifetime() -> None:
            """Hold the SDK context manager open; expose session via future."""
            try:
                async with client.aio.live.connect(
                    model=self.model, config=config
                ) as session:
                    if not session_future.done():
                        session_future.set_result(session)
                    assert self._session_ready is not None
                    self._session_ready.set()
                    # Stay alive until disconnect() fires the shutdown event.
                    assert self._shutdown is not None
                    await self._shutdown.wait()
            except Exception as exc:
                self._session_error = exc
                if not session_future.done():
                    session_future.set_exception(exc)
                assert self._session_ready is not None
                self._session_ready.set()  # unblock connect() even on error

        self._session_task = asyncio.create_task(_session_lifetime())

        # Wait until the session is ready (or errored).
        assert self._session_ready is not None
        await self._session_ready.wait()

        if self._session_error is not None:
            raise self._session_error

        self._session = await session_future
        logger.debug("GeminiLiveAgentAdapter: connected model=%s", self.model)

    async def disconnect(self) -> None:
        """Close the Gemini Live session."""
        if self._shutdown is not None:
            self._shutdown.set()
        if self._session_task is not None:
            try:
                await asyncio.wait_for(self._session_task, timeout=5.0)
            except (asyncio.TimeoutError, Exception):
                pass
        self._session = None
        self._session_task = None
        self._session_ready = None
        self._shutdown = None
        self._session_error = None
        logger.debug("GeminiLiveAgentAdapter: disconnected")

    async def __aenter__(self) -> "GeminiLiveAgentAdapter":
        await self.connect()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.disconnect()

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Send a canonical 24kHz AudioChunk to Gemini Live.

        Resamples from 24kHz → 16kHz at the wire boundary so the adapter
        speaks Gemini's expected ``audio/pcm;rate=16000`` format while the rest
        of the framework stays at the canonical 24kHz.
        """
        if self._session is None:
            raise RuntimeError("GeminiLiveAgentAdapter: not connected")
        from google.genai import types  # noqa: PLC0415

        pcm_16k = _resample_pcm16(chunk.data, CANONICAL_RATE, GEMINI_INPUT_RATE)
        if not pcm_16k:
            return
        blob = types.Blob(data=pcm_16k, mime_type="audio/pcm;rate=16000")
        await self._session.send_realtime_input(audio=blob)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """Receive the next audio response from Gemini Live.

        Iterates the server message stream until an audio part arrives.
        Transcript events update ``self.last_agent_transcript`` in-band.
        Raises ``asyncio.TimeoutError`` if no audio arrives within ``timeout``
        seconds.
        """
        if self._session is None:
            raise RuntimeError("GeminiLiveAgentAdapter: not connected")

        async def _recv_loop() -> AudioChunk:
            async for message in self._session.receive():  # type: ignore[union-attr]
                # Check for server-side errors surfaced as go_away.
                if message.go_away is not None:
                    raise RuntimeError(
                        f"GeminiLiveAgentAdapter: server sent go_away: {message.go_away}"
                    )

                sc = message.server_content
                if sc is None:
                    continue

                # Capture output transcript for observability.
                if sc.output_transcription is not None:
                    transcript_text = getattr(sc.output_transcription, "text", None)
                    if transcript_text:
                        self.last_agent_transcript = transcript_text

                # Extract inline audio data from model_turn parts.
                if sc.model_turn is not None and sc.model_turn.parts:
                    audio_bytes = b""
                    for part in sc.model_turn.parts:
                        if part.inline_data is not None and part.inline_data.data:
                            audio_bytes += part.inline_data.data

                    if audio_bytes:
                        # Gemini outputs 24kHz per docs; no resample needed.
                        # Ensure PCM16 invariant.
                        if len(audio_bytes) % 2 == 1:
                            audio_bytes = audio_bytes[:-1]
                        if audio_bytes:
                            return AudioChunk(data=audio_bytes)

                if sc.turn_complete:
                    # Turn ended with no audio — return silence rather than hang.
                    return AudioChunk(data=b"")

            # Stream exhausted.
            return AudioChunk(data=b"")

        return await asyncio.wait_for(_recv_loop(), timeout=timeout)
