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

from ...config.voice_models import GEMINI_LIVE_MODEL
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
            model=GEMINI_LIVE_MODEL,
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
        # ``interruption=True``: with explicit Activity markers and
        # ``activity_handling=START_OF_ACTIVITY_INTERRUPTS`` (see
        # ``connect``), the next ``activity_start`` we send while the
        # model is replying causes Gemini to cut its in-flight audio.
        # ``interrupt()`` itself just drains stale chunks out of the
        # local queue so the recovery agent turn doesn't replay them.
        interruption=True,
        input_formats=["pcm16/16000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(
        self,
        model: str = GEMINI_LIVE_MODEL,
        voice: str = "Algieba",
        system_instruction: str = "",
        api_key: Optional[str] = None,
    ) -> None:
        super().__init__()
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

        # Cached async iterator on ``session.receive()``. Acquired lazily
        # on the first ``recv_audio`` call so we can iterate the same
        # stream across consecutive agent turns. Without caching, each
        # ``recv_audio`` would call ``session.receive()`` afresh — which
        # the SDK does not support cleanly across turns.
        self._recv_iter: Optional[Any] = None
        # Tracks whether any audio was received on the CURRENT iterator
        # (reset whenever ``_recv_iter`` is recreated). Used by
        # ``recv_audio`` to distinguish a spurious empty-interrupt turn
        # (no audio at all) from a real mid-reply interrupt (audio
        # arrived before the interrupt landed).
        self._iter_had_audio: bool = False

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
        from google import genai  # type: ignore[attr-defined]  # noqa: PLC0415 — lazy import
        from google.genai import types  # noqa: PLC0415

        self._session_ready = asyncio.Event()
        self._shutdown = asyncio.Event()
        loop = asyncio.get_running_loop()
        session_future: asyncio.Future[Any] = loop.create_future()

        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            system_instruction=self.system_instruction or None,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.voice,
                    )
                )
            ),
            # Disable Automatic Activity Detection. AAD requires a clean
            # trailing silence to fire its end-of-speech detector, which is
            # unreliable across the audio shapes scenario produces (TTS'd
            # user-sim audio, scripted clips, layered interruptions). With
            # AAD off we drive turn boundaries explicitly via
            # ``activity_start`` / ``activity_end`` in ``send_audio``;
            # Gemini replies the moment we close the turn instead of
            # waiting on its own VAD heuristic. Activity handling is left
            # at its default (START_OF_ACTIVITY_INTERRUPTS): when we send
            # a new ``activity_start`` while Gemini is mid-reply, the
            # model treats it as a barge-in and cuts its in-flight audio.
            #
            # Subtlety: even after ``generation_complete`` on turn N, the
            # next ``activity_start`` opening turn N+1 is still treated as
            # a barge-in on the just-completed turn. The server emits a
            # spurious ``interrupted → turn_complete`` pair (with no model
            # output) BEFORE actually producing turn N+1's reply. The
            # ``recv_audio`` loop transparently skips that empty pair and
            # re-enters ``session.receive()`` to read the real reply.
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=True,
                ),
            ),
            # Enable transcripts so the recv loop can populate
            # last_agent_transcript / chunk.transcript. Without these,
            # audio still flows but consumers (judge, manifest) get
            # no readable text.
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
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
        self._recv_iter = None
        logger.debug("GeminiLiveAgentAdapter: connected model=%s", self.model)

    async def disconnect(self) -> None:
        """Close the Gemini Live session."""
        if self._recv_iter is not None:
            try:
                await self._recv_iter.aclose()  # type: ignore[attr-defined]
            except Exception:
                # Best-effort teardown: the iterator may already be
                # closed or in an invalid state during shutdown. Any
                # exception here is non-actionable since we're tearing
                # down anyway.
                pass
            self._recv_iter = None
        if self._shutdown is not None:
            self._shutdown.set()
        if self._session_task is not None:
            try:
                await asyncio.wait_for(self._session_task, timeout=5.0)
            except (asyncio.TimeoutError, Exception):
                # Timeout: task didn't finish in 5s — proceed with
                # teardown anyway, can't block disconnect indefinitely.
                # Other Exception: task error during shutdown is
                # non-actionable; we're discarding the session.
                pass
        self._session = None
        self._session_task = None
        self._session_ready = None
        self._shutdown = None
        self._session_error = None
        logger.debug("GeminiLiveAgentAdapter: disconnected")

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Send a canonical 24kHz AudioChunk to Gemini Live as a complete turn.

        Resamples from 24kHz → 16kHz at the wire boundary so the adapter
        speaks Gemini's expected ``audio/pcm;rate=16000`` format while the rest
        of the framework stays at the canonical 24kHz.

        Wraps the audio in explicit ``activity_start`` / ``activity_end``
        markers because we connect with Automatic Activity Detection
        disabled (see ``connect``). Each ``send_audio`` call is therefore a
        complete user turn from Gemini's perspective: it triggers the
        model to reply immediately on ``activity_end`` instead of waiting
        on its own VAD heuristic to detect end-of-speech. This is critical
        for the interrupt path — when the user barges in, we send a fresh
        turn boundary on top of the agent's in-flight reply, which Gemini
        treats as a deterministic interruption signal.
        """
        if self._session is None:
            raise RuntimeError("GeminiLiveAgentAdapter: not connected")
        from google.genai import types  # noqa: PLC0415

        pcm_16k = _resample_pcm16(chunk.data, CANONICAL_RATE, GEMINI_INPUT_RATE)
        if not pcm_16k:
            return
        # New user turn → reset transcript and the per-turn receive
        # iterator so the next ``recv_audio`` enters
        # ``session.receive()`` fresh for this turn.
        self._reset_turn_transcript()
        if self._recv_iter is not None:
            try:
                await self._recv_iter.aclose()  # type: ignore[attr-defined]
            except Exception:
                # Best-effort: prior turn's receive iterator may already be
                # closed or in an error state. We're resetting to start a new
                # turn — propagating here would block legitimate new turns.
                pass
            self._recv_iter = None
        await self._session.send_realtime_input(activity_start=types.ActivityStart())
        blob = types.Blob(
            data=pcm_16k,
            mime_type="audio/pcm;rate=16000",
        )
        await self._session.send_realtime_input(audio=blob)
        await self._session.send_realtime_input(activity_end=types.ActivityEnd())

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """Receive the next audio fragment from Gemini Live for the current turn.

        The SDK's ``session.receive()`` async generator yields messages
        for ONE model turn then stops at ``turn_complete``. We cache the
        per-turn iterator on ``self._recv_iter`` and reset it when the
        previous turn ended (StopAsyncIteration), so each user turn
        sent via ``send_audio`` can read its full reply across multiple
        ``recv_audio`` calls without us re-entering ``session.receive()``
        mid-turn (which would skip messages already buffered server-side).

        Returns the next non-empty audio chunk as soon as it arrives
        so the executor's ``_drain_agent_response`` can set
        ``_agent_speaking_event`` early — the interruption path depends
        on this.

        On ``turn_complete`` returns an empty AudioChunk so the drain
        loop's tail-silence path exits.

        Raises ``asyncio.TimeoutError`` if no chunk arrives within
        ``timeout`` seconds.
        """
        if self._session is None:
            raise RuntimeError("GeminiLiveAgentAdapter: not connected")
        if self._recv_iter is None:
            self._recv_iter = self._session.receive().__aiter__()  # type: ignore[union-attr]
            self._iter_had_audio = False

        async def _next_chunk() -> AudioChunk:
            pending_delta = ""
            # Local-to-call: detects the spurious empty-interrupt turn
            # pattern (server emits ``interrupted=True`` then
            # ``turn_complete=True`` with no audio at all when a fresh
            # ``activity_start`` arrives during turn N's post-
            # ``generation_complete`` playback delay). Combined with
            # ``self._iter_had_audio`` (iterator-scope) we can tell the
            # difference between a spurious turn (no audio ever, on this
            # iterator) and a real mid-reply interrupt (audio arrived
            # earlier on this iterator).
            saw_interrupted = False
            while True:
                try:
                    assert self._recv_iter is not None
                    message = await self._recv_iter.__anext__()  # type: ignore[union-attr]
                except StopAsyncIteration:
                    # The previous turn ended (turn_complete already
                    # consumed). Surface end-of-turn to the drain loop
                    # and reset the iterator so the next user turn
                    # can re-enter session.receive() afresh.
                    self._recv_iter = None
                    return AudioChunk(
                        data=b"",
                        transcript=pending_delta or None,
                    )

                if message.go_away is not None:
                    raise RuntimeError(
                        f"GeminiLiveAgentAdapter: server sent go_away: {message.go_away}"
                    )

                sc = message.server_content
                if sc is None:
                    continue

                if getattr(sc, "interrupted", None):
                    saw_interrupted = True

                if sc.output_transcription is not None:
                    transcript_text = getattr(sc.output_transcription, "text", None)
                    if transcript_text:
                        pending_delta += transcript_text
                        existing = self.last_agent_transcript or ""
                        self.last_agent_transcript = existing + transcript_text

                if sc.model_turn is not None and sc.model_turn.parts:
                    audio_bytes = b""
                    for part in sc.model_turn.parts:
                        if part.inline_data is not None and part.inline_data.data:
                            audio_bytes += part.inline_data.data
                    if audio_bytes:
                        if len(audio_bytes) % 2 == 1:
                            audio_bytes = audio_bytes[:-1]
                        if audio_bytes:
                            self._iter_had_audio = True
                            return AudioChunk(
                                data=audio_bytes,
                                transcript=pending_delta or None,
                            )

                if sc.turn_complete:
                    # Spurious empty-interrupt turn? When activity_start
                    # opens turn N+1 after turn N's generation_complete,
                    # the server emits ``interrupted → turn_complete`` with
                    # no audio FIRST, then the real reply in a separate
                    # turn. Detect that pattern (saw interrupted=True, no
                    # audio on THIS iterator, no transcript) and re-enter
                    # ``session.receive()`` to read the actual reply.
                    #
                    # We gate on ``self._iter_had_audio`` (iterator-scope)
                    # rather than this call's audio: a real mid-reply
                    # interrupt earlier in the same turn would have yielded
                    # audio chunks before this point, even if THIS call sees
                    # only the trailing ``interrupted → turn_complete`` pair.
                    if (
                        saw_interrupted
                        and not self._iter_had_audio
                        and not pending_delta
                    ):
                        self._recv_iter = self._session.receive().__aiter__()  # type: ignore[union-attr]
                        self._iter_had_audio = False
                        saw_interrupted = False
                        continue
                    # Real end-of-turn — yield empty AudioChunk and reset
                    # the iterator. The next ``recv_audio`` call (for the
                    # next user turn) will re-enter ``session.receive()``.
                    self._recv_iter = None
                    return AudioChunk(
                        data=b"",
                        transcript=pending_delta or None,
                    )

        return await asyncio.wait_for(_next_chunk(), timeout=timeout)

    async def interrupt(self) -> None:
        """Drain leftover chunks from the in-flight agent turn so the
        recovery agent's ``recv_audio`` doesn't pick them up as a fake
        first reply.

        On Gemini Live, when we send a fresh ``activity_start`` (the
        next ``send_audio``) while the model is mid-reply, the server
        cuts its in-flight audio AND emits ``turn_complete`` for that
        cancelled turn. ``session.receive()`` is a one-turn generator,
        so the cancelled turn's tail messages still need to be consumed
        before the next ``session.receive()`` invocation can read the
        recovery turn cleanly. ``interrupt()`` consumes them up to that
        ``turn_complete`` and resets the cached iterator.

        Best-effort: bounded by 2 seconds so a stuck stream doesn't
        block the executor's interrupt sequence.
        """
        if self._session is None or self._recv_iter is None:
            return
        try:
            async with asyncio.timeout(2.0):
                while True:
                    try:
                        message = await self._recv_iter.__anext__()  # type: ignore[union-attr]
                    except StopAsyncIteration:
                        break
                    sc = getattr(message, "server_content", None)
                    if sc is not None and sc.turn_complete:
                        break
        except asyncio.TimeoutError:
            # Bounded drain: if the server doesn't close out the turn within
            # 2s after we sent the activity_end, give up and proceed. The
            # finally block will still close the iterator.
            pass
        finally:
            try:
                await self._recv_iter.aclose()  # type: ignore[attr-defined]
            except Exception:
                # Best-effort close; the iterator may already be exhausted
                # or in an error state. Don't mask the original outcome.
                pass
            self._recv_iter = None

    def _reset_turn_transcript(self) -> None:
        """Clear the running transcript before each new agent turn.

        Called from ``send_audio`` so each turn starts fresh — otherwise
        the agent's first reply text would be permanently prefixed onto
        all subsequent turns' transcripts.
        """
        self.last_agent_transcript = None
