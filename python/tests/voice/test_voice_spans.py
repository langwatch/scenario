"""Span-instrumentation tests for the base voice adapter (#770 / #771).

Mic-free: an ``InMemorySpanExporter`` captures the spans the REAL production
``call()`` / ``_drain_agent_response`` emit; only the vendor transport
(``recv_audio``/``send_audio``) is faked. Mirrors the OTel-reset discipline of
``test_live_tracing.py`` (reset the provider AND the set-once guard each test).

Covers the base-adapter ACs A1, A3, A4, A5, A6, A7. The executor-loop spans
(``voice.adapter.connect`` / ``.disconnect`` — A2/A8) and text-only regression
are driven through the executor in ``test_voice_spans_executor.py``.
"""

import asyncio
import logging

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter
from scenario.voice.adapter import AgentStreamEndedError
from scenario.voice.messages import create_audio_message
from scenario.voice.stt import STTProvider, get_stt_provider, set_stt_provider

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


_CHUNK = AudioChunk(data=b"\x00\x00" * 1200, transcript="hi back")  # 4800 bytes


class _ScriptedAdapter(VoiceAgentAdapter):
    """Drives the real base call()/drain; recv_audio replays a scripted sequence.

    Each ``recv_actions`` item is a chunk (returned), ``"timeout"`` (raises
    ``asyncio.TimeoutError``), ``"empty"`` (returns a zero-data chunk), or a
    ``BaseException`` (raised — for the non-timeout first-chunk error case).
    """

    capabilities = AdapterCapabilities(
        input_formats=["pcm16/24000"], output_formats=["pcm16/24000"]
    )

    def __init__(self, recv_actions):
        super().__init__()
        self._actions = list(recv_actions)
        self.sent: list[AudioChunk] = []

    async def connect(self):  # unused here (executor drives connect)
        pass

    async def disconnect(self):
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        self.sent.append(chunk)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if not self._actions:
            raise asyncio.TimeoutError
        action = self._actions.pop(0)
        if action == "timeout":
            raise asyncio.TimeoutError
        if action == "empty":
            return AudioChunk(data=b"", transcript="")
        if isinstance(action, BaseException):
            raise action
        return action


def _audio_input():
    msg = create_audio_message(AudioChunk(data=b"\x00\x00" * 1200), role="user")

    class _FakeInput:
        new_messages = [msg]

    return _FakeInput()


def _greeting_input():
    class _FakeInput:
        new_messages = []  # no incoming audio → no send

    return _FakeInput()


def _by_name(spans):
    return {s.name: s for s in spans}


# --- A1 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a1_call_emits_voice_named_spans():
    """A1: a turn emits spans whose NAME starts with 'voice.' (name, not scope)."""
    exporter = _install_in_memory_provider()
    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    names = [s.name for s in exporter.get_finished_spans()]
    assert any(n.startswith("voice.") for n in names), names
    assert {"voice.turn", "voice.audio.send", "voice.audio.receive"} <= set(names)


# --- A3 -----------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "actions, expected_reason",
    [
        ([_CHUNK, "timeout"], "tail_silence"),
        ([_CHUNK, "empty"], "terminal_chunk"),
        (["timeout"], "first_chunk_timeout"),
        ([_CHUNK, AgentStreamEndedError("peer closed")], "stream_ended"),
    ],
)
async def test_a3_terminated_reason_per_exit_path(actions, expected_reason):
    """A3: voice.audio.receive.terminated_reason names each real drain-exit path."""
    exporter = _install_in_memory_provider()
    adapter = _ScriptedAdapter(actions)
    try:
        await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    except Exception:
        pass  # first_chunk_timeout re-raises FirstChunkTimeoutError — expected
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert attrs(recv)["voice.audio.terminated_reason"] == expected_reason


@pytest.mark.asyncio
async def test_a3_max_duration_reason_and_first_chunk_latency():
    """A3: the runaway backstop is 'max_duration' (py); first_chunk_latency_ms set."""
    exporter = _install_in_memory_provider()
    # Many non-empty chunks so `accumulated` crosses response_max_duration and the
    # loop condition (not a break) ends the drain → 'max_duration'. Transcript set
    # so _ensure_transcript short-circuits (no real STT network call).
    big = AudioChunk(data=b"\x00\x00" * 300_000, transcript="agent")  # ~12.5s @ 24kHz
    await _ScriptedAdapter([big, big, big, big]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert attrs(recv)["voice.audio.terminated_reason"] == "max_duration"
    assert "voice.audio.first_chunk_latency_ms" in attrs(recv)
    assert int_attr(recv, "voice.audio.chunk_count") >= 1


# --- A4 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a4_first_chunk_timeout_marks_error():
    """A4: a first-chunk timeout marks voice.audio.receive ERROR + the label."""
    exporter = _install_in_memory_provider()
    adapter = _ScriptedAdapter(["timeout"])
    with pytest.raises(Exception):
        await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv)["voice.audio.terminated_reason"] == "first_chunk_timeout"


@pytest.mark.asyncio
async def test_a4_non_timeout_first_chunk_error_has_no_timeout_label():
    """A4 negative: a NON-timeout first-chunk error is ERROR but NOT labelled timeout."""
    exporter = _install_in_memory_provider()
    adapter = _ScriptedAdapter([ConnectionResetError("socket died")])
    with pytest.raises(ConnectionResetError):
        await adapter.call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv).get("voice.audio.terminated_reason") != "first_chunk_timeout"


# --- A5 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a5_turn_index_from_scenario_state():
    """A5: voice.turn.index reads input.scenario_state.current_turn (guards a rename)."""
    exporter = _install_in_memory_provider()

    class _State:
        current_turn = 3

    class _InputWithState:
        new_messages = [
            create_audio_message(AudioChunk(data=b"\x00\x00" * 1200), role="user")
        ]
        scenario_state = _State()

    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_InputWithState())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    turn = _by_name(exporter.get_finished_spans())["voice.turn"]
    assert attrs(turn)["voice.turn.index"] == 3


@pytest.mark.asyncio
async def test_a5_turn_span_attrs_and_child_nesting():
    """A5: voice.turn carries attrs; send/receive nest under it (intra-turn tree)."""
    exporter = _install_in_memory_provider()
    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    spans = _by_name(exporter.get_finished_spans())
    turn = spans["voice.turn"]
    assert attrs(turn)["voice.adapter.class"] == "_ScriptedAdapter"
    assert "voice.turn.latency_ms" in attrs(turn)
    assert attrs(turn)["voice.turn.agent_audio_bytes"] == len(_CHUNK.data)
    # send + receive are children of the turn span
    assert parent_id(spans["voice.audio.send"]) == ctx_id(turn)
    assert parent_id(spans["voice.audio.receive"]) == ctx_id(turn)


# --- A6 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a6_audio_send_span_has_bytes():
    """A6: voice.audio.send carries the sent byte count on a real turn."""
    exporter = _install_in_memory_provider()
    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    send = _by_name(exporter.get_finished_spans())["voice.audio.send"]
    assert attrs(send)["voice.audio.bytes"] == 2400  # b"\x00\x00" * 1200


@pytest.mark.asyncio
async def test_a6_no_incoming_turn_emits_no_send_span():
    """A6 edge: a greeting (no-incoming) turn emits zero voice.audio.send spans."""
    exporter = _install_in_memory_provider()
    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_greeting_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    names = [s.name for s in exporter.get_finished_spans()]
    assert "voice.audio.send" not in names
    assert "voice.turn" in names  # the turn still runs


# --- A7 -----------------------------------------------------------------------


class _BoomProcessor(SimpleSpanProcessor):
    def on_end(self, span):  # noqa: D401 - a misbehaving processor
        raise RuntimeError("simulated span-export failure")


@pytest.mark.asyncio
async def test_a7_export_failure_never_breaks_the_turn(caplog):
    """A7 SAFETY: a processor whose on_end raises does not propagate out of call();
    the turn completes and a WARNING is logged by the scenario.voice logger."""
    provider = TracerProvider()
    provider.add_span_processor(_BoomProcessor(InMemorySpanExporter()))
    trace.set_tracer_provider(provider)

    with caplog.at_level(logging.WARNING, logger="scenario.voice"):
        result = await _ScriptedAdapter([_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput

    assert isinstance(result, dict) and result["role"] == "assistant"  # turn completed
    warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and r.name == "scenario.voice"
        and "failed to export" in r.getMessage()
    ]
    assert warnings, "expected a scenario.voice WARNING for the swallowed span-end"


# --- STT (#776) ---------------------------------------------------------------
# Python transcribes per-turn inside call() (_ensure_transcript), so the
# voice.stt.transcribe span nests under voice.turn. TS is per-run (a separate
# test file) — see the #776 decision on the position asymmetry.

_NO_TX_CHUNK = AudioChunk(data=b"\x00\x00" * 1200)  # 2400 bytes, NO transcript


class _FakeSTT(STTProvider):
    """In-process STT stub: returns a fixed text, or raises ``boom`` if set."""

    def __init__(self, text: str = "transcribed", boom: BaseException | None = None):
        self.text = text
        self.boom = boom
        self.calls = 0

    async def transcribe(self, audio: AudioChunk) -> str:
        self.calls += 1
        if self.boom is not None:
            raise self.boom
        return self.text


@pytest.fixture
def restore_stt():
    """Restore the global STT provider after a test swaps it."""
    original = get_stt_provider()
    yield
    set_stt_provider(original)


@pytest.mark.asyncio
async def test_776_stt_span_nested_under_turn(restore_stt):
    """#776: a transcript-less agent turn emits voice.stt.transcribe under voice.turn (scope=turn)."""
    exporter = _install_in_memory_provider()
    set_stt_provider(_FakeSTT(text="hello there"))
    await _ScriptedAdapter([_NO_TX_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    spans = _by_name(exporter.get_finished_spans())
    assert "voice.stt.transcribe" in spans, list(spans)
    stt = spans["voice.stt.transcribe"]
    a = attrs(stt)
    assert a["voice.stt.scope"] == "turn"
    assert a["voice.stt.speaker"] == "agent"
    assert a["voice.stt.audio_bytes"] == 2400
    assert a["voice.stt.transcript_chars"] == len("hello there")
    assert a["voice.adapter.class"] == "_ScriptedAdapter"
    assert a["langwatch.span.type"] == "span"
    # nests under the turn span (Python's per-turn position)
    assert parent_id(stt) == ctx_id(spans["voice.turn"])


@pytest.mark.asyncio
async def test_776_stt_no_span_when_transcript_already_present(restore_stt):
    """#776: a chunk that already carries a transcript emits NO span + makes NO provider call."""
    exporter = _install_in_memory_provider()
    fake = _FakeSTT()
    set_stt_provider(fake)
    # _CHUNK carries transcript="hi back" → _ensure_transcript short-circuits.
    await _ScriptedAdapter([_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    names = [s.name for s in exporter.get_finished_spans()]
    assert "voice.stt.transcribe" not in names
    assert fake.calls == 0


def _exc_events_text(span) -> str:
    """Concatenated text of every exception event recorded on a span."""
    parts = []
    for ev in getattr(span, "events", []) or []:
        a = ev.attributes or {}
        for key in ("exception.type", "exception.message", "exception.stacktrace"):
            value = a.get(key)
            if value:
                parts.append(str(value))
    return " ".join(parts)


@pytest.mark.asyncio
async def test_776_stt_failure_marks_error_but_turn_completes(restore_stt):
    """#776: an STT provider failure marks the span ERROR yet the turn still completes (best-effort),
    and the raw provider message is NOT leaked into the exported span (sanitized)."""
    exporter = _install_in_memory_provider()
    # A provider error whose message embeds a secret-shaped body — the exact
    # OpenAI/ElevenLabs leak the sanitization guards against.
    set_stt_provider(
        _FakeSTT(boom=RuntimeError("401 invalid key sk-abc...wxyz body={...}"))
    )
    result = await _ScriptedAdapter([_NO_TX_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    assert isinstance(result, dict) and result["role"] == "assistant"  # turn completed
    stt = _by_name(exporter.get_finished_spans())["voice.stt.transcribe"]
    assert stt.status.status_code == StatusCode.ERROR
    # no transcript_chars is recorded on the failure path
    assert "voice.stt.transcript_chars" not in attrs(stt)
    # SECURITY (#776 review): the raw provider message must NOT reach the exported
    # span — the recorded exception is sanitized to a provider-agnostic string.
    recorded = _exc_events_text(stt)
    assert "sk-abc" not in recorded
    assert "401" not in recorded
    assert "STT provider failed" in recorded


@pytest.mark.asyncio
async def test_776_stt_empty_text_span_ok_no_chars(restore_stt):
    """#776: an empty STT result → span OK (not ERROR), no transcript_chars, transcript unset."""
    exporter = _install_in_memory_provider()
    set_stt_provider(_FakeSTT(text=""))
    result = await _ScriptedAdapter([_NO_TX_CHUNK, "timeout"]).call(_audio_input())  # type: ignore[arg-type]  # duck-typed input stand-in for AgentInput
    # audio-only message returned unchanged (no transcript part added)
    assert isinstance(result, dict) and result["role"] == "assistant"
    stt = _by_name(exporter.get_finished_spans())["voice.stt.transcribe"]
    assert stt.status.status_code != StatusCode.ERROR
    assert "voice.stt.transcript_chars" not in attrs(stt)
    assert attrs(stt)["voice.stt.audio_bytes"] == 2400
