"""Pipecat-specific voice-span tests (#770 / #774, PR4).

Drives the REAL ``PipecatAgentAdapter`` (base ``call()``/drain + the background
``_recv_loop`` task) with a faked ``websockets`` connection, asserting:

- **P1** — a Pipecat turn emits the #771 base spans with
  ``voice.adapter.class`` = Pipecat, and the connect span carries the
  Pipecat transport attributes.
- **P2** — the background receive loop emits a ``voice.audio.receive`` span
  parented to the turn (not a detached/closed span). This is the core AC: it
  proves the context-capture pattern that Twilio (#770 PR5) reuses.
- **P3** — a receive timeout marks ``voice.audio.receive`` ERROR.
- **P-regression** — no orphaned/leaked span from the background task on
  disconnect.

Mic-free: an ``InMemorySpanExporter`` captures spans from the real production
code; only the vendor WebSocket is faked. Mirrors the OTel-reset discipline of
``test_voice_spans.py`` (reset the provider AND the set-once guard each test).
"""

import asyncio
import base64
import json

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.voice import AudioChunk, PipecatAgentAdapter
from scenario.voice.messages import create_audio_message

from ._span_assert import attrs, ctx_id, int_attr, parent_id


@pytest.fixture(autouse=True)
def reset_otel():
    def _reset() -> None:
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()

    _reset()
    yield
    _reset()


def _install_in_memory_provider() -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


def _by_name(spans):
    return {s.name: s for s in spans}


def _receives(spans):
    """Every ``voice.audio.receive`` span (base + background are same-named)."""
    return [s for s in spans if s.name == "voice.audio.receive"]


_SENTINEL_CLOSE = object()


class _FakeWebSocket:
    """Stand-in for the websockets client connection (see test_pipecat_adapter)."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbox: asyncio.Queue = asyncio.Queue()
        self.closed = False

    async def send(self, text: str) -> None:
        self.sent.append(text)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._inbox.get()
        if item is _SENTINEL_CLOSE:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        self.closed = True
        await self._inbox.put(_SENTINEL_CLOSE)

    def feed(self, frame: str) -> None:
        self._inbox.put_nowait(frame)

    def end_stream(self) -> None:
        self._inbox.put_nowait(_SENTINEL_CLOSE)


def _media_frame(stream_sid: str, mulaw: bytes) -> str:
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(mulaw).decode()},
        }
    )


# 100 ms of µ-law silence (800 bytes) = the adapter's coalescing batch → one chunk.
_ONE_CHUNK_MULAW = b"\x7f" * 800

# Arbitrary stream SID for the synthetic media frames — the recv loop's parser
# ignores it, so any value works (and it avoids an Optional[str] narrowing on the
# adapter's own stream_sid, which pyright can't prove non-None post-connect).
_STREAM_SID = "MZtest"


def _audio_input():
    msg = create_audio_message(AudioChunk(data=b"\x00\x00" * 1200), role="user")

    class _State:
        current_turn = 0

    class _FakeInput:
        new_messages = [msg]
        scenario_state = _State()

    return _FakeInput()


async def _connect(monkeypatch, adapter):
    fake = _FakeWebSocket()

    async def _fake_connect(url, **_):
        return fake

    monkeypatch.setattr("websockets.connect", _fake_connect)
    await adapter.connect()
    return fake


# --- P1 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_p1_turn_emits_base_spans_with_pipecat_class(monkeypatch):
    """P1: a Pipecat turn inherits the #771 base spans, class = Pipecat."""
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    adapter.response_tail_silence = 0.05  # end the drain fast after one chunk
    fake = await _connect(monkeypatch, adapter)
    try:
        fake.feed(_media_frame(_STREAM_SID, _ONE_CHUNK_MULAW))
        merged = AudioChunk(data=b"\x00\x00" * 10, transcript="hi")  # short-circuit STT
        adapter._ensure_transcript = _AsyncReturn(merged)  # type: ignore[method-assign]
        await adapter.call(_audio_input())  # type: ignore[arg-type]
    finally:
        fake.end_stream()
        await adapter.disconnect()

    spans = _by_name(exporter.get_finished_spans())
    assert {"voice.turn", "voice.audio.send", "voice.audio.receive"} <= set(spans)
    assert attrs(spans["voice.turn"])["voice.adapter.class"] == "PipecatAgentAdapter"


@pytest.mark.asyncio
async def test_p1_connect_span_carries_pipecat_transport_attrs(monkeypatch):
    """P1: the adapter stamps its transport onto the base voice.adapter.connect span.

    Driven through the executor connect loop (which owns the connect span), the
    same seam ElevenLabs uses for voice.elevenlabs.agent_id.
    """
    from scenario.scenario_executor import ScenarioExecutor

    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    fake = _FakeWebSocket()

    async def _fake_connect(url, **_):
        return fake

    monkeypatch.setattr("websockets.connect", _fake_connect)
    executor = ScenarioExecutor(
        name="pipecat-span-test", description="test", agents=[adapter], script=[]
    )
    try:
        await executor._voice_connect_all()
    finally:
        fake.end_stream()
        await executor._voice_disconnect_all()

    connect = _by_name(exporter.get_finished_spans())["voice.adapter.connect"]
    assert attrs(connect)["voice.adapter.class"] == "PipecatAgentAdapter"
    assert attrs(connect)["voice.pipecat.transport"] == "websocket"
    assert attrs(connect)["voice.pipecat.transport_format"] == "mulaw/8000"


# --- P2 (core) ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_p2_background_receive_span_parented_to_turn(monkeypatch):
    """P2 (core AC): the background ``_recv_loop`` emits a ``voice.audio.receive``
    span parented DIRECTLY to the turn — proving the context-capture pattern
    (the loop task's own OTel context was frozen at connect, a closed span)."""
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    adapter.response_tail_silence = 0.05
    fake = await _connect(monkeypatch, adapter)
    try:
        # Feed one agent chunk BEFORE call(). call() publishes the turn context
        # SYNCHRONOUSLY (before its first await), so the background loop — which
        # runs during call()'s awaits — decodes this frame under a LIVE turn.
        fake.feed(_media_frame(_STREAM_SID, _ONE_CHUNK_MULAW))
        adapter._ensure_transcript = _AsyncReturn(  # type: ignore[method-assign]
            AudioChunk(data=b"\x00\x00" * 10, transcript="hi")
        )
        await adapter.call(_audio_input())  # type: ignore[arg-type]
    finally:
        fake.end_stream()
        await adapter.disconnect()

    spans = exporter.get_finished_spans()
    turn = _by_name(spans)["voice.turn"]
    bg = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.pipecat.recv.source") == "background_loop"
    ]
    assert bg, "expected a background-loop voice.audio.receive span"
    # The core assertion: parented directly under the turn, NOT a detached/closed
    # span (the loop's frozen connect-time context).
    assert parent_id(bg[0]) == ctx_id(turn)
    assert int_attr(bg[0], "voice.audio.bytes") > 0


@pytest.mark.asyncio
async def test_p2_one_background_span_per_turn_not_per_chunk(monkeypatch):
    """P2 flood-guard: several wire deliveries in ONE turn emit exactly ONE
    background span — matching the base's one-receive-span-per-turn granularity
    and the epic's no-per-tick-flood rule (the EL pump H1)."""
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    adapter.response_tail_silence = 0.05
    fake = await _connect(monkeypatch, adapter)
    try:
        for _ in range(3):  # three 100 ms chunks, one turn
            fake.feed(_media_frame(_STREAM_SID, _ONE_CHUNK_MULAW))
        adapter._ensure_transcript = _AsyncReturn(  # type: ignore[method-assign]
            AudioChunk(data=b"\x00\x00" * 10, transcript="hi")
        )
        await adapter.call(_audio_input())  # type: ignore[arg-type]
    finally:
        fake.end_stream()
        await adapter.disconnect()

    bg = [
        s
        for s in _receives(exporter.get_finished_spans())
        if attrs(s).get("voice.pipecat.recv.source") == "background_loop"
    ]
    assert len(bg) == 1, f"expected one background span per turn, got {len(bg)}"


@pytest.mark.asyncio
async def test_prebuffered_turn_has_base_span_but_no_background_marker(monkeypatch):
    """Documents the turn-liveness gate limit (review F2): agent audio delivered
    and enqueued BEFORE call() publishes the turn context (e.g. a greeting during
    connect) is drained from the queue without a fresh wire delivery, so it gets
    NO background marker — the base voice.audio.receive span still covers it."""
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    adapter.response_tail_silence = 0.05
    fake = await _connect(monkeypatch, adapter)
    try:
        fake.feed(_media_frame(_STREAM_SID, _ONE_CHUNK_MULAW))
        await asyncio.sleep(0.05)  # _recv_loop decodes+enqueues with NO turn live
        adapter._ensure_transcript = _AsyncReturn(  # type: ignore[method-assign]
            AudioChunk(data=b"\x00\x00" * 10, transcript="hi")
        )
        await adapter.call(_audio_input())  # type: ignore[arg-type]  # drains the pre-buffered chunk
    finally:
        fake.end_stream()
        await adapter.disconnect()

    spans = exporter.get_finished_spans()
    base = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.pipecat.recv.source") != "background_loop"
    ]
    bg = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.pipecat.recv.source") == "background_loop"
    ]
    assert base, "base drain receive span should still be present"
    assert bg == [], "a pre-buffered turn emits no background marker (by design)"


@pytest.mark.asyncio
async def test_pregression_no_background_span_between_turns(monkeypatch):
    """P-regression: a chunk decoded with NO active turn emits NO background span.

    The turn-liveness gate keeps the background task from leaking a
    detached/closed-parent span (e.g. a late frame after the turn closed, or a
    pre-turn greeting frame). Also covers the disconnect teardown path.
    """
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    fake = await _connect(monkeypatch, adapter)
    # No call() in flight → _voice_turn_context is None → _recv_loop buffers the
    # decoded chunk but emits no span.
    fake.feed(_media_frame(_STREAM_SID, _ONE_CHUNK_MULAW))
    await asyncio.sleep(0.05)  # let the background loop process the frame
    await adapter.disconnect()

    bg = [
        s
        for s in _receives(exporter.get_finished_spans())
        if attrs(s).get("voice.pipecat.recv.source") == "background_loop"
    ]
    assert bg == [], "no background receive span should be emitted between turns"


# --- P3 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_p3_receive_timeout_marks_receive_span_error(monkeypatch):
    """P3: a first-chunk receive timeout (no audio fed) marks voice.audio.receive ERROR."""
    exporter = _install_in_memory_provider()
    adapter = PipecatAgentAdapter(url="ws://bot/ws")
    adapter.response_timeout = 0.05  # fail the first-chunk wait fast (feed nothing)
    fake = await _connect(monkeypatch, adapter)
    try:
        with pytest.raises(Exception):
            await adapter.call(_audio_input())  # type: ignore[arg-type]
    finally:
        fake.end_stream()
        await adapter.disconnect()

    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv)["voice.audio.terminated_reason"] == "first_chunk_timeout"


class _AsyncReturn:
    """A tiny awaitable-returning stand-in for _ensure_transcript (avoids real STT)."""

    def __init__(self, value):
        self._value = value

    async def __call__(self, _merged):
        return self._value
