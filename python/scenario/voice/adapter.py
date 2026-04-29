"""
VoiceAgentAdapter — base class for voice-capable agents.

Extends AgentAdapter (text-based) with audio send/receive primitives and a
capability matrix. Concrete subclasses live under
``scenario.voice.adapters`` (PipecatAgentAdapter, LiveKitAgentAdapter, etc.).

The scenario executor calls ``connect()`` automatically at scenario start and
``disconnect()`` at end — users do not manage lifecycle.

The default ``call()`` implementation records the audio it sends and receives
into the executor's ``VoiceRecording`` so ``result.audio`` is populated without
each adapter needing its own bookkeeping.
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import abstractmethod
from typing import ClassVar, List, Optional

logger = logging.getLogger("scenario.voice")

from ..agent_adapter import AgentAdapter
from ..types import AgentInput, AgentReturnTypes, AgentRole
from .audio_chunk import AudioChunk
from .capabilities import AdapterCapabilities
from .messages import create_audio_message, extract_audio
from .recording import AudioSegment, VoiceEvent


class VoiceAgentAdapter(AgentAdapter):
    """
    Abstract base for voice agents that exchange audio with the agent under test.

    Subclasses implement ``connect``, ``disconnect``, ``send_audio``, and
    ``recv_audio``. The default ``call`` implementation threads audio extracted
    from the last incoming message through the transport and wraps the response
    back into an assistant message.

    Attributes:
        capabilities: Declaration of what the adapter can and cannot do. Each
            concrete subclass must set this as a class attribute.
        response_timeout: Seconds to wait for agent audio after sending user
            audio. Defaults to 30 seconds.
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities()
    response_timeout: float = 30.0
    # Tail silence: once the first agent chunk arrives, keep draining recv_audio
    # until no chunk shows up within this many seconds — that's how we detect the
    # agent finished talking. Without this, demos record only the first ~100ms.
    response_tail_silence: float = 0.6
    # Hard cap on a single agent turn's audio. Prevents runaway loops if a
    # transport never signals end-of-stream. 30s = a long sentence.
    response_max_duration: float = 30.0

    @property
    def _agent_speaking_event(self) -> asyncio.Event:
        """Event set when the agent emits its first chunk of the current turn.

        Lazy-init avoids forcing every subclass to call super().__init__()
        (the existing adapters don't, and changing all of them is invasive).
        Used by the interruption path to wait until the agent is actually
        speaking before firing an interrupt — so we don't fire ``clear`` at
        a silent SUT.
        """
        ev = self.__dict__.get("_agent_speaking")
        if ev is None:
            ev = asyncio.Event()
            self.__dict__["_agent_speaking"] = ev
        return ev

    @abstractmethod
    async def connect(self) -> None:
        """Open the transport and prepare to exchange audio."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Close the transport and release resources."""

    @abstractmethod
    async def send_audio(self, chunk: AudioChunk) -> None:
        """Transmit an AudioChunk to the agent under test."""

    @abstractmethod
    async def recv_audio(self, timeout: float) -> AudioChunk:
        """Receive the next AudioChunk from the agent."""

    async def interrupt(self) -> None:
        """Send a first-class interrupt signal to the agent under test.

        Adapters that advertise ``capabilities.interruption=True`` override
        this to send the transport-native interrupt (e.g., Twilio ``clear``,
        OpenAI Realtime ``response.cancel``). The agent stops generating
        audio immediately — much more deterministic than racing VAD against
        a wall-clock sleep.

        The default raises ``UnsupportedCapabilityError``. Callers
        (``scenario.interrupt()``) check ``capabilities.interruption`` and
        fall back to timing-based barge-in (sending audio while the agent
        is speaking) when this returns False.
        """
        from .capabilities import UnsupportedCapabilityError

        raise UnsupportedCapabilityError(
            type(self).__name__,
            "interruption",
            hint=(
                "This adapter has no native interrupt signal. Use the "
                "timing-based barge-in pattern instead: "
                "agent(wait=False) + sleep(N) + user(content), where the "
                "user audio overlaps with the agent's TTS and the SUT's "
                "VAD detects it."
            ),
        )

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Default implementation: extract audio from the latest user message,
        send it, drain the agent's full response (multiple recv_audio chunks
        until tail silence), record once, return as one assistant audio message.

        Why drain instead of taking one chunk: TTS and realtime APIs stream
        their response in many small chunks. A single recv_audio() returns the
        first one only — the recorder would log ~100ms of agent audio per turn
        and the judge would receive a truncated response. Draining until
        tail-silence (no new chunk for ``response_tail_silence`` seconds) gives
        the natural "agent finished talking" signal that works across
        adapters without each one needing to know its transport's done event.

        Subclasses may override this for specialised flows but will usually
        inherit it.
        """
        # Clear the speaking-event for this turn — set in _drain on first chunk.
        self._agent_speaking_event.clear()
        recorder = _AdapterRecorder(input)
        incoming = extract_audio(input.new_messages[-1]) if input.new_messages else None
        if incoming is not None:
            recorder.record_user(incoming)
            await self.send_audio(incoming)
        recorder.mark_user_stopped()
        merged = await self._drain_agent_response()
        recorder.record_agent(merged)
        return create_audio_message(merged, role="assistant")

    async def _drain_agent_response(self) -> AudioChunk:
        """Loop ``recv_audio`` until tail silence or max duration; merge result."""
        first = await self.recv_audio(timeout=self.response_timeout)
        # First chunk arrived → agent is now speaking. Wakes anyone awaiting
        # _agent_speaking_event (the interruption path).
        self._agent_speaking_event.set()
        chunks: List[AudioChunk] = [first]
        accumulated = first.duration_seconds
        while accumulated < self.response_max_duration:
            try:
                nxt = await self.recv_audio(timeout=self.response_tail_silence)
            except asyncio.TimeoutError:
                break
            if not nxt.data:
                break
            chunks.append(nxt)
            accumulated += nxt.duration_seconds
        return _merge_chunks(chunks)


class _AdapterRecorder:
    """Bridges a single call() turn's audio and timing into the executor state.

    Kept as a private helper so the default ``VoiceAgentAdapter.call`` stays
    short and each subclass can opt-out by overriding ``call()``.
    """

    def __init__(self, input: AgentInput) -> None:
        state = getattr(input, "scenario_state", None)
        executor = getattr(state, "_executor", None) if state is not None else None
        self._executor = executor
        self._start = time.monotonic()
        self._user_stopped_at: Optional[float] = None

    def _offset(self) -> float:
        anchor = getattr(self._executor, "_voice_recording_started_at", None)
        if anchor is None:
            return 0.0
        return time.monotonic() - anchor

    def record_user(self, chunk: AudioChunk) -> None:
        # We're called AFTER the audio has been transmitted (or assembled),
        # so the offset NOW is the end of the segment, not the start. Compute
        # start by subtracting the chunk's natural duration. Without this the
        # manifest's start_time looks like the END of the speaking interval.
        if self._executor is None or not chunk.data:
            return
        _fire_audio_chunk(self._executor, chunk)
        end = self._offset()
        start = max(0.0, end - chunk.duration_seconds)
        _append_segment(self._executor, "user", start, end, chunk)
        _append_event(self._executor, VoiceEvent(time=start, type="user_start_speaking"))
        _append_event(self._executor, VoiceEvent(time=end, type="user_stop_speaking"))

    def mark_user_stopped(self) -> None:
        self._user_stopped_at = self._offset()

    def record_agent(self, chunk: AudioChunk) -> None:
        # Same convention as record_user: we're called when the agent finished
        # speaking (drain returned), so `now` is end_time and start is derived.
        if self._executor is None or not chunk.data:
            return
        _fire_audio_chunk(self._executor, chunk)
        end = self._offset()
        start = max(0.0, end - chunk.duration_seconds)
        _append_segment(self._executor, "agent", start, end, chunk)
        latency = None
        if self._user_stopped_at is not None:
            latency = max(0.0, start - self._user_stopped_at)
            _record_latency(self._executor, latency)
        _append_event(
            self._executor,
            VoiceEvent(time=start, type="agent_start_speaking", latency=latency),
        )
        _append_event(self._executor, VoiceEvent(time=end, type="agent_stop_speaking"))


def _merge_chunks(chunks: List[AudioChunk]) -> AudioChunk:
    """Concatenate PCM bytes from drained agent chunks into one AudioChunk.

    Transcripts: each adapter populates ``chunk.transcript`` differently —
    some on the last chunk (after STT settles), some incrementally. Joining
    non-empty transcripts with a space preserves whatever the adapter shipped
    without forcing adapters to coordinate.
    """
    if len(chunks) == 1:
        return chunks[0]
    data = b"".join(c.data for c in chunks)
    parts = [c.transcript for c in chunks if c.transcript]
    transcript = " ".join(parts) if parts else None
    return AudioChunk(data=data, transcript=transcript)


def _append_segment(executor, speaker: str, start: float, end: float, chunk: AudioChunk) -> None:
    recording = getattr(executor, "_voice_recording", None)
    if recording is None:
        return
    recording.segments.append(
        AudioSegment(
            speaker=speaker,  # type: ignore[arg-type]
            start_time=start,
            end_time=end,
            audio=chunk.data,
            transcript=chunk.transcript,
        )
    )


def _append_event(executor, event: VoiceEvent) -> None:
    timeline = getattr(executor, "_voice_timeline", None)
    if timeline is None:
        return
    timeline.append(event)
    hook = getattr(executor, "_on_voice_event", None)
    if hook is not None:
        try:
            hook(event)
        except Exception:
            logger.warning(
                "on_voice_event callback raised; continuing scenario.",
                exc_info=True,
            )


def _fire_audio_chunk(executor, chunk: AudioChunk) -> None:
    hook = getattr(executor, "_on_audio_chunk", None)
    if hook is None:
        return
    try:
        hook(chunk)
    except Exception:
        logger.warning(
            "on_audio_chunk callback raised; continuing scenario.",
            exc_info=True,
        )


def _record_latency(executor, latency: float) -> None:
    metrics = getattr(executor, "_voice_latency", None)
    if metrics is None:
        return
    metrics.measurements.append(latency)
    if metrics.time_to_first_byte is None:
        metrics.time_to_first_byte = latency
