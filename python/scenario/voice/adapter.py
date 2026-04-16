"""
VoiceAgentAdapter — base class for voice-capable agents.

Extends AgentAdapter (text-based) with audio send/receive primitives and a
capability matrix. Concrete subclasses live under
``scenario.voice.adapters`` (PipecatAgent, LiveKitAgent, etc.).

The scenario executor calls ``connect()`` automatically at scenario start and
``disconnect()`` at end — users do not manage lifecycle.

The default ``call()`` implementation records the audio it sends and receives
into the executor's ``VoiceRecording`` so ``result.audio`` is populated without
each adapter needing its own bookkeeping.
"""

from __future__ import annotations

import logging
import time
from abc import abstractmethod
from typing import ClassVar, Optional

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

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Default implementation: extract audio from the latest user message,
        send it, wait for a response, return as an assistant audio message.

        Subclasses may override this for specialised flows but will usually
        inherit it.
        """
        recorder = _AdapterRecorder(input)
        incoming = extract_audio(input.new_messages[-1]) if input.new_messages else None
        if incoming is not None:
            recorder.record_user(incoming)
            await self.send_audio(incoming)
        recorder.mark_user_stopped()
        response = await self.recv_audio(timeout=self.response_timeout)
        recorder.record_agent(response)
        return create_audio_message(response, role="assistant")


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
        if self._executor is None or not chunk.data:
            return
        _fire_audio_chunk(self._executor, chunk)
        start = self._offset()
        end = start + chunk.duration_seconds
        _append_segment(self._executor, "user", start, end, chunk)
        _append_event(self._executor, VoiceEvent(time=start, type="user_start_speaking"))
        _append_event(self._executor, VoiceEvent(time=end, type="user_stop_speaking"))

    def mark_user_stopped(self) -> None:
        self._user_stopped_at = self._offset()

    def record_agent(self, chunk: AudioChunk) -> None:
        if self._executor is None or not chunk.data:
            return
        _fire_audio_chunk(self._executor, chunk)
        start = self._offset()
        end = start + chunk.duration_seconds
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
