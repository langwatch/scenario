"""OpenAI Realtime-specific voice-span attributes (#770 / #773).

Mirrors the ElevenLabs PR1 slice (``test_voice_spans_elevenlabs.py``, #771)
for the OpenAI Realtime adapter. Drives the REAL
``OpenAIRealtimeAgentAdapter`` over a queue-backed mock WebSocket
(``_MockWS`` + the event-sequence builders, copied from
``test_realtime_tool_calls.py``) with an ``InMemorySpanExporter`` capturing
the spans the production ``call()`` / ``_drain_agent_response`` emit.

Per the design spec's load-bearing architectural facts:
- The realtime ``call()``/``_drain_agent_response`` both delegate to
  ``super()``, so the BASE ``voice.turn`` / ``voice.audio.send`` /
  ``voice.audio.receive`` spans (and the first-chunk-timeout ERROR path) are
  INHERITED for free — R1 and R3 below prove that inheritance holds through
  this adapter's overrides (the tool-call bookkeeping in ``call()``, the
  transcript rebuild in ``_drain_agent_response``). Because that base
  instrumentation already shipped in #771, R1/R3 may already be GREEN on a
  pre-#773 tree — that is expected, not a test bug (see the design doc's
  "R1 + R3 are INHERITED" note).
- ``recv_audio`` runs INSIDE the base ``voice.audio.receive`` span's ambient
  OTel context (it is invoked BY the base drain), so it can stamp markers
  and attributes onto ``get_current_span()`` — that is the R2 seam R2a/R2b
  exercise below, and it is genuinely new (RED before #773).
- R-connect exercises the vendor attrs ``connect()`` stamps onto
  ``voice.adapter.connect``, driven through the REAL executor connect loop
  (mirrors the EL ``agent_id`` test) — also genuinely new (RED before #773).

R-regression (existing ``test_realtime_*`` staying green) is not a new test
here — the orchestrator runs the existing suite.
"""

import asyncio
import base64
import json
from typing import Any, List
from unittest.mock import AsyncMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.scenario_executor import ScenarioExecutor
from scenario.voice import AudioChunk
from scenario.voice._telemetry import voice_span
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter
from scenario.voice.messages import create_audio_message

from ._span_assert import attrs, ctx_id, int_attr, parent_id


@pytest.fixture(autouse=True)
def reset_otel():
    """Reset OTel global provider + the set-once guard around each test."""

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


# --- _MockWS + event-sequence builders (copied from test_realtime_tool_calls.py) --


def _make_pcm(n_samples: int = 480) -> bytes:
    """Minimal silent PCM16 mono @ 24 kHz."""
    return b"\x00\x00" * n_samples


def _b64_pcm(n_samples: int = 480) -> str:
    return base64.b64encode(_make_pcm(n_samples)).decode()


class _MockWS:
    """Queue-backed WebSocket mock (mirrors test_realtime_tool_calls.py).

    ``recv()`` pops pre-loaded JSON event strings in order; once exhausted it
    raises asyncio.TimeoutError (tail silence). ``send()`` is recorded.
    """

    def __init__(self, events: List[str]) -> None:
        self._events = list(events)
        self._idx = 0
        self.sent: List[Any] = []

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)

    async def recv(self) -> str:
        if self._idx >= len(self._events):
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("mock WS: no more events")
        evt = self._events[self._idx]
        self._idx += 1
        return evt

    async def close(self) -> None:
        pass


def _audio_delta_events() -> List[str]:
    """A few audio deltas + transcript + response.done — a normal spoken turn.

    recv_audio only RETURNS on an audio delta, so every turn that goes through
    call()/drain needs at least one audio delta to terminate the drain loop.
    """
    chunk = _b64_pcm(480)
    return [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps(
            {
                "type": "response.output_audio_transcript.done",
                "transcript": "Let me look that up for you.",
            }
        ),
        json.dumps({"type": "response.done"}),
    ]


def _function_call_streaming_events(
    call_id: str, name: str, arguments: str
) -> List[str]:
    """The streaming-args form of a function call: deltas → done.

    Splits ``arguments`` across two deltas to exercise accumulation, with the
    name arriving via the output_item.added shell (as the real wire does — the
    `.done` event typically omits `name`).
    """
    mid = len(arguments) // 2
    return [
        json.dumps(
            {
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "name": name,
                    "call_id": call_id,
                },
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.delta",
                "call_id": call_id,
                "delta": arguments[:mid],
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.delta",
                "call_id": call_id,
                "delta": arguments[mid:],
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.done",
                "call_id": call_id,
                "arguments": arguments,
            }
        ),
    ]


def _make_adapter(events: List[str]) -> OpenAIRealtimeAgentAdapter:
    """Build an adapter wired to a _MockWS pre-loaded with ``events``."""
    adapter = OpenAIRealtimeAgentAdapter()
    adapter._ws = _MockWS(events)
    return adapter


def _audio_input():
    """AgentInput stand-in carrying ONE incoming user-audio message, so the
    base call() flow fires voice.audio.send (R1 needs this to prove the send
    span emits; harmless for the other cases)."""
    msg = create_audio_message(AudioChunk(data=b"\x00\x00" * 1200), role="user")

    class _FakeInput:
        new_messages = [msg]

    return _FakeInput()


# --- R1 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r1_base_spans_inherited_with_adapter_class_and_nesting():
    """R1 (inherited): call()/_drain_agent_response delegate to super(), so
    the base voice.turn / voice.audio.send / voice.audio.receive spans emit
    for free, tagged with THIS adapter's class name; receive nests under
    turn. Expected to already pass pre-#773 (see module docstring)."""
    exporter = _install_in_memory_provider()
    adapter = _make_adapter(_audio_delta_events())

    await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    spans = _by_name(exporter.get_finished_spans())
    assert {"voice.turn", "voice.audio.send", "voice.audio.receive"} <= set(spans)
    turn = spans["voice.turn"]
    assert attrs(turn)["voice.adapter.class"] == "OpenAIRealtimeAgentAdapter"
    recv = spans["voice.audio.receive"]
    assert parent_id(recv) == ctx_id(turn)


# --- R2a / R2b (the realtime event-loop marker seam) -----------------------


@pytest.mark.asyncio
async def test_r2a_response_markers_and_zero_tool_call_count():
    """R2a: response.created/.done land as EVENTS on the receive span (name =
    voice.realtime.{etype}), and tool_call_count is stamped 0 — set even when
    no tool ran, so the attribute is uniformly present."""
    exporter = _install_in_memory_provider()
    adapter = _make_adapter(_audio_delta_events())

    await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    event_names = [e.name for e in recv.events]
    assert "voice.realtime.response.created" in event_names
    assert "voice.realtime.response.done" in event_names
    assert int_attr(recv, "voice.realtime.tool_call_count") == 0


@pytest.mark.asyncio
async def test_r2b_tool_call_count_reflects_completed_call():
    """R2b: a function call finalized BEFORE response.done stamps
    voice.realtime.tool_call_count == 1 (the count must be set before the
    _completed_tool_calls empty-chunk short-circuit that ends the turn)."""
    exporter = _install_in_memory_provider()
    # response.done LAST (realistic ordering): the call must be finalized
    # before response.done, otherwise the snapshot the production code takes
    # at response.done would still be empty. Deliberately NOT
    # `_audio_delta_events() + _function_call_streaming_events(...)` — that
    # concatenation puts response.done BEFORE the tool-call events, which
    # would (still, post-impl) stamp tool_call_count=0.
    events = (
        [
            json.dumps({"type": "response.created"}),
            json.dumps(
                {"type": "response.output_audio.delta", "delta": _b64_pcm(480)}
            ),
        ]
        + _function_call_streaming_events("call_1", "get_weather", '{"x":1}')
        + [json.dumps({"type": "response.done"})]
    )
    adapter = _make_adapter(events)

    await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert int_attr(recv, "voice.realtime.tool_call_count") == 1


# --- R2c (interrupt effect: response.cancelled) -----------------------------


@pytest.mark.asyncio
async def test_r2c_response_cancelled_marker_captured():
    """R2c: interrupt() surfaces on the wire as response.cancelled (not
    response.done) — the R2 marker captures it just like a normal completion,
    proving interrupt() needs no span of its own (#773 design doc: its effect
    is already caught by this response-terminal marker)."""
    exporter = _install_in_memory_provider()
    events = [
        json.dumps({"type": "response.created"}),
        json.dumps(
            {"type": "response.output_audio.delta", "delta": _b64_pcm(480)}
        ),
        json.dumps({"type": "response.cancelled"}),
    ]
    adapter = _make_adapter(events)

    await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    event_names = [e.name for e in recv.events]
    assert "voice.realtime.response.created" in event_names
    assert "voice.realtime.response.cancelled" in event_names


# --- R3 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_r3_first_chunk_timeout_marks_error_inherited():
    """R3 (inherited): a first-chunk timeout still marks voice.audio.receive
    ERROR with the base first_chunk_timeout label through the realtime
    override — proves the tool-call/transcript wrapping doesn't swallow the
    base FirstChunkTimeoutError path. Expected to already pass pre-#773."""
    exporter = _install_in_memory_provider()
    adapter = _make_adapter([])  # _MockWS([]) — first recv_audio times out

    with pytest.raises(Exception):
        await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv)["voice.audio.terminated_reason"] == "first_chunk_timeout"


# --- R-connect ---------------------------------------------------------------


def _exec(adapter: OpenAIRealtimeAgentAdapter) -> ScenarioExecutor:
    return ScenarioExecutor(
        name="realtime-voice-span-test",
        description="test",
        agents=[adapter],
        script=[],
    )


@pytest.mark.asyncio
async def test_rconnect_stamps_realtime_vendor_attrs_on_connect_span():
    """R-connect: connect() stamps model/voice/session_type/tool_count onto
    the voice.adapter.connect span the executor's connect loop opens —
    driven through the REAL executor connect loop (mirrors the EL agent_id
    test, test_voice_spans_elevenlabs.py)."""
    exporter = _install_in_memory_provider()
    adapter = OpenAIRealtimeAgentAdapter(
        model="gpt-realtime-mini",
        voice="alloy",
        tools=[{"type": "function", "name": "noop"}],
    )
    executor = _exec(adapter)

    with patch("websockets.connect", new=AsyncMock(return_value=_MockWS([]))):
        await executor._voice_connect_all()
        await executor._voice_disconnect_all()

    connect = _by_name(exporter.get_finished_spans())["voice.adapter.connect"]
    assert attrs(connect)["voice.adapter.class"] == "OpenAIRealtimeAgentAdapter"
    assert attrs(connect)["voice.realtime.model"] == "gpt-realtime-mini"
    assert attrs(connect)["voice.realtime.voice"] == "alloy"
    assert attrs(connect)["voice.realtime.session_type"] == "realtime"
    assert int_attr(connect, "voice.realtime.tool_count") == 1


# --- Security (defense-in-depth deny-list) -----------------------------------


_SENSITIVE_ATTR_KEY_TERMS = (
    "api_key",
    "apikey",
    "authorization",
    "instruction",
    "persona",
    "transcript",
    "arguments",
    "secret",
    "bearer",
)


@pytest.mark.asyncio
async def test_no_sensitive_data_stamped_on_realtime_spans():
    """Security (defense-in-depth, #773): span instrumentation must NEVER
    stamp the API key, persona/instructions, transcripts, or tool-call
    arguments onto a span — as an attribute KEY, an attribute VALUE, or an
    event name. This telemetry exports to LangWatch and the taxonomy here is
    copied by 4 more adapter PRs, so a leak in this shared pattern would ship
    broadly. Drives a real connect span (key-shaped api_key + a persona +
    tools configured) plus a full AGENT turn (which populates a transcript),
    then scans every finished span for the deny-listed key terms and the
    literal secret substrings."""
    exporter = _install_in_memory_provider()
    api_key = "sk-REALKEYSHAPE1234567890"
    persona = "SECRET_PERSONA_DO_NOT_LEAK"
    adapter = OpenAIRealtimeAgentAdapter(
        instructions=persona,
        api_key=api_key,
        tools=[{"type": "function", "name": "noop"}],
    )

    with patch("websockets.connect", new=AsyncMock(return_value=_MockWS([]))):
        with voice_span("voice.adapter.connect", {}):
            await adapter.connect()

    adapter._ws = _MockWS(_audio_delta_events())
    await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    for span in exporter.get_finished_spans():
        for key, value in attrs(span).items():
            lowered_key = key.lower()
            assert not any(
                term in lowered_key for term in _SENSITIVE_ATTR_KEY_TERMS
            ), f"span {span.name!r} stamped a deny-listed attribute key: {key!r}"
            if isinstance(value, str):
                assert api_key not in value, (
                    f"span {span.name!r} attribute {key!r} leaked the api key: "
                    f"{value!r}"
                )
                assert persona not in value, (
                    f"span {span.name!r} attribute {key!r} leaked the persona: "
                    f"{value!r}"
                )
        event_names = [e.name for e in span.events]
        for event_name in event_names:
            assert api_key not in event_name, (
                f"span {span.name!r} event name leaked the api key: {event_name!r}"
            )
            assert persona not in event_name, (
                f"span {span.name!r} event name leaked the persona: {event_name!r}"
            )
