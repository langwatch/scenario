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
from typing import Any, Callable, ClassVar, List, Optional

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
            audio. Defaults to 60 seconds.

            60 seconds covers a typical real-world STT → LLM → TTS round-trip
            including backoff/retry inside each provider, tool calls, and RAG
            lookups. If you see TimeoutError flakes against a fast LLM-only
            chain, you can lower this; if your agent does heavy processing
            (MCP roundtrips, multi-step tool chains), consider raising it.

            Override per-adapter at construction time::

                adapter = MyVoiceAdapter()
                adapter.response_timeout = 90.0  # slow tool-call chain
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities()
    response_timeout: float = 60.0  # 60s: STT + LLM + TTS budget (see docstring)
    # Tail silence: once the first agent chunk arrives, keep draining recv_audio
    # until no chunk shows up within this many seconds — that's how we detect the
    # agent finished talking. Without this, demos record only the first ~100ms.
    response_tail_silence: float = 0.6
    # Hard cap on a single agent turn's audio. Prevents runaway loops if a
    # transport never signals end-of-stream. 30s = a long sentence.
    response_max_duration: float = 30.0

    def __init__(self) -> None:
        # Per-instance event used by the interruption path to wait until
        # the agent is actually speaking before firing an interrupt — so
        # we don't fire ``clear`` at a silent SUT. Subclasses that
        # override ``__init__`` must call ``super().__init__()``.
        self._agent_speaking = asyncio.Event()

    @property
    def _agent_speaking_event(self) -> asyncio.Event:
        """Event set when the agent emits its first chunk of the current turn."""
        # Safety net for subclasses that pre-date this base ``__init__``
        # contract and didn't call ``super().__init__()``. They get a
        # one-shot lazy event so the interruption path doesn't crash.
        # We emit a single warning per subclass — silent fallback masks
        # bugs, but a warning per call would spam the timing-critical
        # interruption path. New adapters must call super().__init__().
        ev = getattr(self, "_agent_speaking", None)
        if ev is None:
            cls = type(self)
            if not getattr(cls, "_agent_speaking_lazy_warned", False):
                logger.warning(
                    "%s.__init__() did not call super().__init__(); "
                    "lazily initialising _agent_speaking event. "
                    "Add super().__init__() to silence this warning.",
                    cls.__name__,
                )
                # setattr() form: pyright won't infer this dynamic class attr
                # otherwise (reportAttributeAccessIssue). Functionally identical
                # to cls._agent_speaking_lazy_warned = True.
                setattr(cls, "_agent_speaking_lazy_warned", True)
            ev = asyncio.Event()
            self._agent_speaking = ev
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

    async def __aenter__(self):
        # Default async context manager: subclasses don't need to
        # reimplement this — they get connect/disconnect sandwiching
        # for free. Override only if a transport needs extra setup
        # ordering around connect.
        await self.connect()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.disconnect()

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
            # Wrap send_audio so user.start = "we began transmitting" and
            # user.end = "we finished transmitting" — both real flow points.
            recorder.mark_user_start()
            await self.send_audio(incoming)
            recorder.record_user(incoming)
        # Drain. Recorder grabs agent.start at first chunk via
        # mark_agent_start, so agent.start is "first chunk on the wire,"
        # not "now minus merged.duration."
        merged = await self._drain_agent_response(on_first_chunk=recorder.mark_agent_start)
        recorder.record_agent(merged)
        return create_audio_message(merged, role="assistant")

    async def _drain_agent_response(
        self, on_first_chunk: Optional[Callable[[], None]] = None
    ) -> AudioChunk:
        """Loop ``recv_audio`` until tail silence or max duration; merge result.

        ``on_first_chunk`` is invoked synchronously the moment the first
        non-empty audio chunk arrives — used by the recorder to capture
        agent.start at a real flow point rather than back-computing from
        the merged-chunk duration.
        """
        first = await self.recv_audio(timeout=self.response_timeout)
        # First chunk arrived → agent is now speaking. Wakes anyone awaiting
        # _agent_speaking_event (the interruption path).
        if first.data and on_first_chunk is not None:
            on_first_chunk()
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

    Timing model: every segment's start/end is captured at a real audio
    flow point — when transmission begins, when it ends, when the first
    chunk arrives. Nothing is back-computed from chunk byte length, so
    user and agent segments share a single timeline and do not overlap.
    """

    def __init__(self, input: AgentInput) -> None:
        # ``scenario_state`` is declared on AgentInput, but tests use lightweight
        # _FakeInput stubs that don't carry it. Guard so the recorder
        # degrades to a no-op (segments unwritten) instead of crashing the
        # call(), matching the established test-double seam.
        state = getattr(input, "scenario_state", None)
        executor = getattr(state, "_executor", None) if state is not None else None
        self._executor = executor
        self._user_start: Optional[float] = None
        self._user_end: Optional[float] = None
        self._agent_start: Optional[float] = None

    def _offset(self) -> float:
        anchor = getattr(self._executor, "_voice_recording_started_at", None)
        if anchor is None:
            return 0.0
        return time.monotonic() - anchor

    def mark_user_start(self) -> None:
        """Capture the moment send_audio begins transmitting user audio."""
        self._user_start = self._offset()

    def record_user(self, chunk: AudioChunk) -> None:
        """Finalise the user segment after send_audio returns.

        Uses real flow timestamps: start = when transmission began,
        end = now (transmission complete). The chunk's intrinsic
        duration is metadata only, not used to compute timestamps.
        """
        if self._executor is None or not chunk.data:
            return
        # mark_user_start should have been called; if not (e.g. an adapter
        # subclass invokes record_user directly), fall back to back-
        # computation so the segment is at least roughly placed.
        end = self._offset()
        start = self._user_start if self._user_start is not None else max(
            0.0, end - chunk.duration_seconds
        )
        self._user_end = end
        write_user_segment(self._executor, chunk, start, end)

    def mark_agent_start(self) -> None:
        """Capture the moment the first agent chunk arrives.

        Called by ``_drain_agent_response`` synchronously when its first
        non-empty chunk lands, so the agent segment's start reflects when
        audio actually started flowing back from the AUT — not when drain
        eventually returns.
        """
        self._agent_start = self._offset()

    def record_agent(self, chunk: AudioChunk) -> None:
        """Finalise the agent segment after drain completes.

        start = when first chunk arrived (captured by mark_agent_start).
        end = now (drain has settled).
        latency = agent.start - user.end. Real measurement; no clamp.
        """
        if self._executor is None or not chunk.data:
            return
        _fire_audio_chunk(self._executor, chunk)
        end = self._offset()
        # Fall back if a subclass bypassed the on_first_chunk hook.
        start = self._agent_start if self._agent_start is not None else max(
            0.0, end - chunk.duration_seconds
        )
        _append_segment(self._executor, "agent", start, end, chunk)
        latency = None
        if self._user_end is not None:
            latency = start - self._user_end
            # Negative latency means the agent began emitting audio before
            # the user audio finished transmitting — which the wire model
            # forbids on serial adapters. Treat as a measurement artefact
            # and skip the record so p50/p95 aren't poisoned.
            if latency >= 0:
                _record_latency(self._executor, latency)
            else:
                latency = None
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


def write_user_segment(executor, chunk: AudioChunk, start: float, end: float) -> None:
    """Append a finalised user segment + start/stop timeline events.

    Single path that both ``_AdapterRecorder.record_user`` (the default
    ``call()`` flow) and ``ScenarioExecutor._record_interrupt_user_segment``
    (the barge-in flow that bypasses the recorder) call into. Previously
    those two paths each open-coded the same four-step sequence
    (``_fire_audio_chunk`` + ``_append_segment`` + two ``_append_event``s),
    drifting apart as the timing model evolved.
    """
    if executor is None or not chunk.data:
        return
    _fire_audio_chunk(executor, chunk)
    _append_segment(executor, "user", start, end, chunk)
    _append_event(executor, VoiceEvent(time=start, type="user_start_speaking"))
    _append_event(executor, VoiceEvent(time=end, type="user_stop_speaking"))


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
