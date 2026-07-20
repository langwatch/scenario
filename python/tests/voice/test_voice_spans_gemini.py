"""Gemini-Live voice-span attributes (#770 / #772, PR2 of the epic).

Drives the REAL ``GeminiLiveAgentAdapter`` — its production ``connect`` /
``send_audio`` / ``recv_audio`` / ``interrupt`` — against a faked ``genai.Client``
whose session yields scripted ``server_content`` messages (the
``test_gemini_live_echo_safe.py::test_wrapper_real_connect_call_disconnect_smoke``
pattern), asserting the Gemini contributions onto the base/executor spans:

  - ``voice.gemini.model`` / ``voice.gemini.voice`` on ``voice.adapter.connect``
  - ``voice.gemini.audio.wire_bytes`` on ``voice.audio.send``
  - ``voice.gemini.turn_complete`` / ``voice.gemini.spurious_retry_count`` on the
    inherited ``voice.audio.receive`` span
  - ``voice.gemini.interrupt.outcome`` / ``voice.gemini.interrupt.drained_chunks``
    on the executor-owned ``voice.adapter.interrupt`` span

Gemini overrides transport primitives ONLY, so it INHERITS ``voice.turn`` /
``voice.audio.send`` / ``voice.audio.receive`` (base ``call``/``_drain_agent_response``)
and the executor lifecycle spans for free — several ACs here are regression locks
proving that inheritance rather than RED→GREEN of a new stamp.

Vendor transport is faked at the network-client boundary (``genai.Client``),
never by substituting a stub for adapter privates — the ban #697 exists for.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, List

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.config.voice_models import GEMINI_LIVE_MODEL
from scenario.scenario_executor import ScenarioExecutor
from scenario.voice.adapter import FirstChunkTimeoutError
from scenario.voice.adapters.gemini_live import GeminiLiveAgentAdapter
from scenario.voice.audio_chunk import AudioChunk
from scenario.voice.testing import drive_call, make_agent_input
from scenario.voice._telemetry import voice_span

from ._span_assert import attrs, int_attr


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


def _fresh_provider() -> InMemorySpanExporter:
    """Reset the set-once guard and install a NEW provider (for multi-run tests)."""
    trace._TRACER_PROVIDER = None
    trace._TRACER_PROVIDER_SET_ONCE = Once()
    return _install_in_memory_provider()


def _by_name(spans):
    return {s.name: s for s in spans}


# --------------------------------------------------------------------------- #
# Duck-typed Gemini Live server-message shapes (no google-genai import here).
# Mirrors ``test_gemini_live_echo_safe.py`` — recv_audio reads message.go_away,
# message.server_content{.interrupted,.output_transcription.text,.model_turn.parts,
# .turn_complete}.
# --------------------------------------------------------------------------- #


class _FakeInlineData:
    def __init__(self, data: bytes) -> None:
        self.data = data


class _FakePart:
    def __init__(self, data: bytes) -> None:
        self.inline_data = _FakeInlineData(data)


class _FakeModelTurn:
    def __init__(self, parts: List[_FakePart]) -> None:
        self.parts = parts


class _FakeTranscription:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeServerContent:
    def __init__(
        self,
        *,
        output_transcription: Any = None,
        model_turn: Any = None,
        turn_complete: bool = False,
        interrupted: bool = False,
    ) -> None:
        self.output_transcription = output_transcription
        self.model_turn = model_turn
        self.turn_complete = turn_complete
        self.interrupted = interrupted


class _FakeLiveServerMessage:
    def __init__(self, server_content: Any) -> None:
        self.go_away = None
        self.server_content = server_content


class _GoAwayMessage:
    """A server-terminate message: recv_audio raises on ``go_away is not None``."""

    def __init__(self) -> None:
        self.go_away = "server terminate"
        self.server_content = None


class _FakeSession:
    """Duck-typed ``AsyncSession``: ``receive()`` returns a fresh generator per
    call that yields the NEXT scheduled turn's messages then stops — matching the
    real one-turn-per-generator SDK contract that recv_audio re-enters on each
    spurious pair and each new user turn."""

    def __init__(self, turns: List[List[Any]]) -> None:
        self._turns = list(turns)
        self._turn_idx = 0
        self.sent: List[Any] = []

    def receive(self):
        if self._turn_idx < len(self._turns):
            msgs = self._turns[self._turn_idx]
            self._turn_idx += 1
        else:
            msgs = []

        async def _gen():
            for m in msgs:
                await asyncio.sleep(0)
                yield m

        return _gen()

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def close(self) -> None:
        pass


class _HangSession:
    """A session whose ``receive()`` never yields — forces a recv timeout."""

    def __init__(self) -> None:
        self.sent: List[Any] = []

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def close(self) -> None:
        pass

    def receive(self):
        async def _gen():
            await asyncio.sleep(3600)
            yield None  # pragma: no cover — never reached before the recv timeout

        return _gen()


def _make_pcm(n_samples: int = 2400) -> bytes:
    """Silent PCM16 mono @24kHz (2400 samples → 3200 bytes after 24k→16k)."""
    return b"\x00\x00" * n_samples


def _real_audio_turn(transcript: str = "hello there") -> List[_FakeLiveServerMessage]:
    """One agent turn: an audio+transcript message, then turn_complete."""
    return [
        _FakeLiveServerMessage(
            _FakeServerContent(
                output_transcription=_FakeTranscription(transcript),
                model_turn=_FakeModelTurn([_FakePart(_make_pcm(2400))]),
            )
        ),
        _FakeLiveServerMessage(_FakeServerContent(turn_complete=True)),
    ]


def _spurious_pair() -> List[_FakeLiveServerMessage]:
    """The spurious empty-interrupt turn Gemini emits between turns:
    ``interrupted`` then ``turn_complete`` with no audio/transcript."""
    return [
        _FakeLiveServerMessage(_FakeServerContent(interrupted=True)),
        _FakeLiveServerMessage(_FakeServerContent(turn_complete=True)),
    ]


def _install_fake_client(monkeypatch, session) -> None:
    """Monkeypatch ``genai.Client`` so the REAL ``connect()`` builds its real
    LiveConnectConfig + background session task against ``session``."""
    from google import genai

    class _CM:
        async def __aenter__(self):
            return session

        async def __aexit__(self, *exc_info):
            return False

    class _Live:
        def connect(self, *, model, config):
            return _CM()

    class _Aio:
        live = _Live()

    class _Client:
        def __init__(self, api_key=None):
            self.aio = _Aio()

    monkeypatch.setattr(genai, "Client", _Client)


# --- AC1 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac1_call_emits_voice_span_set_with_gemini_class(monkeypatch):
    """AC1: a bare call() emits {voice.turn, voice.audio.send, voice.audio.receive}
    with voice.turn carrying voice.adapter.class == 'GeminiLiveAgentAdapter'; a
    no-incoming (greeting) turn emits NO voice.audio.send. All base-owned — Gemini
    inherits call()/_drain_agent_response unchanged."""
    exporter = _install_in_memory_provider()
    _install_fake_client(monkeypatch, _FakeSession([_real_audio_turn()]))
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        await drive_call(
            adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
        )
    finally:
        await adapter.disconnect()

    spans = _by_name(exporter.get_finished_spans())
    assert {"voice.turn", "voice.audio.send", "voice.audio.receive"} <= set(spans)
    assert attrs(spans["voice.turn"])["voice.adapter.class"] == "GeminiLiveAgentAdapter"

    # A greeting (no incoming audio) emits NO voice.audio.send span.
    exporter2 = _fresh_provider()
    _install_fake_client(monkeypatch, _FakeSession([_real_audio_turn()]))
    adapter2 = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter2.connect()
    try:
        await drive_call(adapter2, make_agent_input())  # greeting → no send
    finally:
        await adapter2.disconnect()
    names2 = [s.name for s in exporter2.get_finished_spans()]
    assert "voice.audio.send" not in names2
    assert "voice.turn" in names2


# --- AC2 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac2_connect_span_carries_gemini_model_and_voice(monkeypatch):
    """AC2: driving the executor connect/disconnect loops emits
    voice.adapter.connect (carrying voice.gemini.model + voice.gemini.voice) and
    voice.adapter.disconnect, both with the class attr."""
    exporter = _install_in_memory_provider()
    _install_fake_client(monkeypatch, _FakeSession([]))
    adapter = GeminiLiveAgentAdapter(voice="Puck", api_key="test-gk")
    executor = ScenarioExecutor(
        name="gemini-connect-span", description="t", agents=[adapter], script=[]
    )
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()

    spans = _by_name(exporter.get_finished_spans())
    connect = spans["voice.adapter.connect"]
    assert attrs(connect)["voice.adapter.class"] == "GeminiLiveAgentAdapter"
    assert attrs(connect)["voice.gemini.model"] == GEMINI_LIVE_MODEL
    assert attrs(connect)["voice.gemini.voice"] == "Puck"
    disconnect = spans["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.adapter.class"] == "GeminiLiveAgentAdapter"


# --- AC3 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac3_send_span_carries_gemini_wire_bytes(monkeypatch):
    """AC3: voice.audio.send carries voice.gemini.audio.wire_bytes == the resampled
    length (2400 samples @24k → 1600 @16k → 3200 bytes), and the turn was framed."""
    exporter = _install_in_memory_provider()
    session = _FakeSession([_real_audio_turn()])
    _install_fake_client(monkeypatch, session)
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        await drive_call(
            adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
        )
    finally:
        await adapter.disconnect()
    send = _by_name(exporter.get_finished_spans())["voice.audio.send"]
    assert int_attr(send, "voice.gemini.audio.wire_bytes") == 3200
    # The real resample ran and framed a full turn: activity_start / audio / activity_end.
    assert len(session.sent) == 3


@pytest.mark.asyncio
async def test_ac3_empty_resample_stamps_zero_and_sends_no_markers(monkeypatch):
    """AC3 edge: a chunk that resamples to empty → voice.audio.send present with
    wire_bytes==0 and the session receives NO activity_start/audio/activity_end."""
    exporter = _install_in_memory_provider()
    session = _FakeSession([_real_audio_turn()])
    _install_fake_client(monkeypatch, session)
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        # 1 sample @24k → int(1*16000/24000)==0 → empty resample.
        await drive_call(adapter, make_agent_input(user_audio=AudioChunk(data=b"\x00\x00")))
    finally:
        await adapter.disconnect()
    send = _by_name(exporter.get_finished_spans())["voice.audio.send"]
    assert int_attr(send, "voice.gemini.audio.wire_bytes") == 0
    assert session.sent == []  # no activity_start / audio / activity_end


# --- AC4 ---------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("k", [0, 1, 3])
async def test_ac4_receive_span_carries_spurious_retry_count(monkeypatch, k):
    """AC4: after a drain with K scripted spurious interrupt→turn_complete pairs
    then real audio, voice.audio.receive carries voice.gemini.spurious_retry_count
    == K and voice.gemini.turn_complete True (K==0 on a clean turn)."""
    exporter = _install_in_memory_provider()
    session = _FakeSession([_spurious_pair() for _ in range(k)] + [_real_audio_turn()])
    _install_fake_client(monkeypatch, session)
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        await drive_call(
            adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
        )
    finally:
        await adapter.disconnect()
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert int_attr(recv, "voice.gemini.spurious_retry_count") == k
    assert attrs(recv)["voice.gemini.turn_complete"] is True


# --- AC5 (inherited) ---------------------------------------------------------


@pytest.mark.asyncio
async def test_ac5_first_chunk_timeout_marks_error_and_chains_cause(monkeypatch):
    """AC5 (inherited): a first-chunk recv timeout → voice.audio.receive ERROR +
    terminated_reason=='first_chunk_timeout', and the original asyncio.TimeoutError
    survives as FirstChunkTimeoutError.__cause__ — Gemini flows through the base
    contract unchanged."""
    exporter = _install_in_memory_provider()
    _install_fake_client(monkeypatch, _HangSession())
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    adapter.response_timeout = 0.05  # keep the first-chunk wait short
    await adapter.connect()
    try:
        with pytest.raises(FirstChunkTimeoutError) as excinfo:
            await drive_call(adapter, make_agent_input())
        assert isinstance(excinfo.value.__cause__, asyncio.TimeoutError)
    finally:
        await adapter.disconnect()
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv)["voice.audio.terminated_reason"] == "first_chunk_timeout"


# --- AC6 (inherited) ---------------------------------------------------------


@pytest.mark.asyncio
async def test_ac6_go_away_marks_error_without_timeout_label(monkeypatch):
    """AC6 (inherited): a go_away (server terminate) on the first chunk → the
    RuntimeError propagates, voice.audio.receive is ERROR, and terminated_reason is
    NOT 'first_chunk_timeout' (a real transport error, not a timeout)."""
    exporter = _install_in_memory_provider()
    _install_fake_client(monkeypatch, _FakeSession([[_GoAwayMessage()]]))
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        with pytest.raises(RuntimeError) as excinfo:
            await drive_call(adapter, make_agent_input())
        assert "go_away" in str(excinfo.value)
    finally:
        await adapter.disconnect()
    recv = _by_name(exporter.get_finished_spans())["voice.audio.receive"]
    assert recv.status.status_code == StatusCode.ERROR
    assert attrs(recv).get("voice.audio.terminated_reason") != "first_chunk_timeout"


# --- AC7 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac7a_executor_interrupt_site_opens_span_and_stamps_outcome():
    """AC7: the executor interrupt site opens a voice.adapter.interrupt span (the
    6th executor-owned base span) and the adapter stamps its outcome onto it. A
    recv iterator that yields turn_complete immediately →
    outcome=='drained_to_turn_complete' with an int drained_chunks."""
    exporter = _install_in_memory_provider()
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    # interrupt() only needs a non-None session + a recv iterator to drain.
    adapter._session = object()

    async def _tc_gen():
        yield _FakeLiveServerMessage(_FakeServerContent(turn_complete=True))

    adapter._recv_iter = _tc_gen()
    adapter._agent_speaking_event.set()  # don't wait 15s for speech

    # Bare executor with just the state _fire_user_interrupt reads (the
    # test_interruption.py pattern) — everything else is getattr-guarded.
    executor = ScenarioExecutor.__new__(ScenarioExecutor)
    executor.agents = [adapter]

    async def _sleep():
        await asyncio.sleep(10.0)

    pending = asyncio.create_task(_sleep())
    executor._pending_agent_task = pending

    # Text-only voiced message → _extract_audio_from_message returns None, so the
    # barge-in skips send_audio and isolates the native interrupt() span.
    await ScenarioExecutor._fire_user_interrupt(
        executor, {"role": "user", "content": "wait, stop"}
    )

    if not pending.done():
        pending.cancel()
        try:
            await pending
        except (asyncio.CancelledError, Exception):
            pass

    span = _by_name(exporter.get_finished_spans())["voice.adapter.interrupt"]
    assert attrs(span)["voice.adapter.class"] == "GeminiLiveAgentAdapter"
    assert attrs(span)["voice.gemini.interrupt.outcome"] == "drained_to_turn_complete"
    assert isinstance(attrs(span)["voice.gemini.interrupt.drained_chunks"], int)


@pytest.mark.asyncio
async def test_ac7b_interrupt_no_op_when_not_connected():
    """AC7: interrupt() with no session stamps outcome=='no_op_not_connected' and
    drained_chunks==0 onto the active voice.adapter.interrupt span."""
    exporter = _install_in_memory_provider()
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")  # never connected → _session None
    with voice_span(
        "voice.adapter.interrupt",
        {"voice.adapter.class": type(adapter).__name__},
    ):
        await adapter.interrupt()
    span = _by_name(exporter.get_finished_spans())["voice.adapter.interrupt"]
    assert attrs(span)["voice.gemini.interrupt.outcome"] == "no_op_not_connected"
    assert int_attr(span, "voice.gemini.interrupt.drained_chunks") == 0


# --- AC8 ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac8_one_receive_span_per_turn_count_invariant_to_spurious_retries(
    monkeypatch,
):
    """AC8: exactly one voice.audio.receive span per turn, and the total voice.*
    span count is invariant across a 1-spurious-retry and a 3-spurious-retry drain
    (recv_audio stamps attributes, never opens spans — the taxonomy guard)."""

    async def _run(k: int):
        exporter = _fresh_provider()
        session = _FakeSession(
            [_spurious_pair() for _ in range(k)] + [_real_audio_turn()]
        )
        _install_fake_client(monkeypatch, session)
        adapter = GeminiLiveAgentAdapter(api_key="test-gk")
        await adapter.connect()
        try:
            await drive_call(
                adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
            )
        finally:
            await adapter.disconnect()
        voice_spans = [
            s for s in exporter.get_finished_spans() if s.name.startswith("voice.")
        ]
        receive_spans = [s for s in voice_spans if s.name == "voice.audio.receive"]
        return len(voice_spans), len(receive_spans)

    total_1, recv_1 = await _run(1)
    total_3, recv_3 = await _run(3)
    assert recv_1 == 1
    assert recv_3 == 1
    assert total_1 == total_3


# --- AC9 (safety) ------------------------------------------------------------


class _BoomProcessor(SimpleSpanProcessor):
    def on_end(self, span) -> None:  # noqa: D401 - a misbehaving processor
        raise RuntimeError("simulated span-export failure")


@pytest.mark.asyncio
async def test_ac9_span_export_failure_never_breaks_a_gemini_turn(monkeypatch, caplog):
    """AC9 SAFETY: a SpanProcessor whose on_end raises does not break a Gemini turn;
    call() still returns the assistant audio message (never-raise contract), and a
    WARNING is logged by the scenario.voice logger."""
    provider = TracerProvider()
    provider.add_span_processor(_BoomProcessor(InMemorySpanExporter()))
    trace.set_tracer_provider(provider)

    _install_fake_client(monkeypatch, _FakeSession([_real_audio_turn()]))
    adapter = GeminiLiveAgentAdapter(api_key="test-gk")
    await adapter.connect()
    try:
        with caplog.at_level(logging.WARNING, logger="scenario.voice"):
            result = await drive_call(
                adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
            )
    finally:
        await adapter.disconnect()

    assert isinstance(result, dict) and result["role"] == "assistant"  # turn completed
    warnings = [
        r
        for r in caplog.records
        if r.levelno == logging.WARNING
        and r.name == "scenario.voice"
        and "failed to export" in r.getMessage()
    ]
    assert warnings, "expected a scenario.voice WARNING for the swallowed span-end"
