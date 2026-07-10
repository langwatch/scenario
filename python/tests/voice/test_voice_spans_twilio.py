"""Twilio-specific voice-span attributes (#770 / #771 taxonomy, #775 scope).

Drives the REAL ``TwilioAgentAdapter`` (REST mocked, media transport driven
through the real ``TwilioWebhookServer`` loop over a scripted/controllable WS
double) through the executor connect/disconnect loops and through
``place_call()``/``wait_for_call()`` directly, asserting the Twilio
contributions this PR adds:

- T1: base spans (voice.turn / voice.audio.send / voice.audio.receive) are
  NOT hollow for Twilio. REGRESSION GUARD — already GREEN before any #775
  instrumentation lands (Twilio does not override ``call()``).
- T2: ``voice.adapter.connect`` carries Twilio connect-time config attrs.
- T3: ``voice.adapter.disconnect`` carries call-lifetime counters (frames,
  DTMF, stream-ended reason, REST-restore-failed, webhook invocation/
  rejection counts).
- T4/T5: a NEW ``voice.adapter.dial`` span wraps ``place_call()`` /
  ``wait_for_call()`` — the REST dial + the ``_stream_connected`` wait.
- T6: dial ERROR on a stream-connect timeout (the marquee "I placed the call
  but no media ever streamed" failure) — ``dial_outcome=="stream_connect_timeout"``.
- T7: dial ERROR on a REST failure records the ORIGINAL exception.
- T8: a misbehaving SpanProcessor at the dial site never breaks ``place_call()``.
- T9: py<->ts parity — see the comment block near the bottom; not
  independently testable inside one language's suite.
- T10: span count is invariant to media-frame count (flood guard).

Design doc: sc#775 "Twilio voice-adapter LangWatch spans: design + ACs".
Harness patterns copied (not cross-imported, matching
``test_voice_spans_elevenlabs.py``'s local ``_FakeWs`` convention) from
``test_twilio_adapter.py`` (``FakeREST`` / ``_install_fake_rest``) and
``test_twilio_silent_stop_drain.py`` (``_ScriptedWS`` / ``_ControllableWS`` /
``drive_twilio_production``).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

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
from scenario.voice import AudioChunk, TwilioAgentAdapter
from scenario.voice.adapters._twilio_shared import build_media_frame
from scenario.voice.testing.wrapper_harness import (
    drive_call,
    drive_twilio_production,
    make_agent_input,
    make_connected_twilio_adapter,
)

from ._span_assert import attrs, ctx_id, int_attr, parent_id


# --------------------------------------------------------------------------- otel infra


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
    """Every ``voice.audio.receive`` span (base drain + background-loop marker
    share the same NAME, disambiguated only by ``voice.twilio.recv.source``)."""
    return [s for s in spans if s.name == "voice.audio.receive"]


def _exec(adapter: TwilioAgentAdapter) -> ScenarioExecutor:
    return ScenarioExecutor(
        name="twilio-voice-span-test", description="test", agents=[adapter], script=[]
    )


# --------------------------------------------------------------------------- Twilio REST double
#
# Local copy of the FakeREST / _install_fake_rest pattern from
# test_twilio_adapter.py. Span-test files in this suite duplicate their
# vendor doubles rather than cross-import another test module —
# test_voice_spans_elevenlabs.py does the same with its own local _FakeWs.


class FakeREST:
    """In-memory stand-in for TwilioRESTHelper, recording every mutation."""

    def __init__(self, account_sid: str = "", auth_token: str = "") -> None:
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.write_calls: list[tuple[str, str]] = []
        self.place_call_kwargs: list[dict[str, Any]] = []
        self._prior_voice_url = "https://old-webhook.example.com/previous"

    def resolve_phone_number_sid(self, number: str) -> str:
        return "PN" + "0" * 32

    def read_voice_url(self, sid: str) -> str:
        return self._prior_voice_url

    def write_voice_url(self, sid: str, url: str) -> None:
        self.write_calls.append((sid, url))

    def place_call(self, *, to: str, from_: str, twiml: str) -> str:
        # Mirrors the real TwilioRESTHelper.place_call signature.
        self.place_call_kwargs.append({"to": to, "from_": from_, "twiml": twiml})
        return "CA" + "1" * 32

    def send_dtmf_on_call(self, call_sid: str, tones: str) -> None:
        pass


def _install_fake_rest(monkeypatch: Any) -> list[FakeREST]:
    """Patch the REST helper and suppress the uvicorn server task. Returns the
    list that collects every FakeREST instance constructed."""
    rest_instances: list[FakeREST] = []

    def _factory(account_sid: str, auth_token: str) -> FakeREST:
        r = FakeREST(account_sid, auth_token)
        rest_instances.append(r)
        return r

    monkeypatch.setattr("scenario.voice.adapters.twilio.TwilioRESTHelper", _factory)

    async def _fake_run_server(self: Any) -> None:
        return

    monkeypatch.setattr(TwilioAgentAdapter, "_run_server", _fake_run_server)
    return rest_instances


def _make_adapter(**overrides: Any) -> TwilioAgentAdapter:
    kwargs: dict[str, Any] = dict(
        account_sid="AC" + "0" * 32,
        auth_token="secret",
        phone_number="+14155551234",
        public_base_url="https://example.trycloudflare.com",
        validate_signature=False,
    )
    kwargs.update(overrides)
    return TwilioAgentAdapter(**kwargs)


# --------------------------------------------------------------------------- media-loop frame builders

STREAM_SID = "MZ775"
CALL_SID = "CA775"


def _start_frame(stream_sid: str = STREAM_SID, call_sid: str = CALL_SID) -> str:
    return json.dumps(
        {"event": "start", "start": {"streamSid": stream_sid, "callSid": call_sid}}
    )


def _stop_frame() -> str:
    return json.dumps({"event": "stop"})


def _dtmf_frame(digit: str, stream_sid: str = STREAM_SID) -> str:
    return json.dumps(
        {"event": "dtmf", "streamSid": stream_sid, "dtmf": {"digit": digit}}
    )


class _ScriptedWS:
    """Compact starlette-WebSocket double: serves ``frames`` in order, then
    raises ``close_with`` (or, absent that, errors on exhaustion). Trimmed
    local copy of the pattern in ``test_twilio_silent_stop_drain.py``."""

    def __init__(
        self, frames: list[str], *, close_with: Optional[BaseException] = None
    ) -> None:
        self._frames = list(frames)
        self._idx = 0
        self._close_with = close_with
        self.sent: list[str] = []

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if self._idx < len(self._frames):
            msg = self._frames[self._idx]
            self._idx += 1
            return msg
        if self._close_with is not None:
            raise self._close_with
        raise AssertionError(  # pragma: no cover
            "scripted WS exhausted without a terminal frame"
        )

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


class _ControllableWS:
    """WS double the test can feed mid-flight: ``receive_text()`` blocks until
    ``push()`` supplies a frame. Needed where the media loop must stay LIVE
    while the test drives a concurrent ``call()`` (T1) — the scripted double
    above always finishes first."""

    def __init__(self) -> None:
        self._queue: "asyncio.Queue[Any]" = asyncio.Queue()
        self.sent: list[str] = []

    def push(self, item: Any) -> None:
        self._queue.put_nowait(item)

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        item = await self._queue.get()
        if isinstance(item, BaseException):
            raise item
        return item

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


# --- T1 (regression) -----------------------------------------------------------


@pytest.mark.asyncio
async def test_t1_regression_call_emits_turn_send_receive_with_twilio_class():
    """T1 (REGRESSION — already GREEN before any #775 instrumentation lands):
    TwilioAgentAdapter does not override ``call()`` (twilio.py inherits
    adapter.py:202), so a turn driven over a real (mocked-transport) media
    stream already emits ``voice.turn`` with child ``voice.audio.send`` +
    ``voice.audio.receive``, ``voice.adapter.class=='TwilioAgentAdapter'``,
    and correct parent nesting. Pinned here so a future refactor can't
    silently hollow this out for Twilio specifically.
    """
    exporter = _install_in_memory_provider()
    adapter = make_connected_twilio_adapter()
    adapter.response_tail_silence = 0.05  # keep the test fast
    ws = _ControllableWS()
    loop_task = asyncio.create_task(drive_twilio_production(adapter, ws))
    ws.push(_start_frame())
    assert adapter._stream_connected is not None
    await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2.0)

    # One real agent-audio media frame >= the 800-byte batch threshold, so it
    # flushes into the inbound queue immediately — deterministic, no sleep-race.
    ws.push(build_media_frame(STREAM_SID, bytes([0x7F]) * 800))
    await asyncio.sleep(0.05)  # let the loop task drain the pushed frame

    user_audio = AudioChunk(data=b"\x00\x00" * 1200)
    await drive_call(adapter, make_agent_input(user_audio))

    ws.push(_stop_frame())
    await asyncio.wait_for(loop_task, timeout=2.0)

    spans = _by_name(exporter.get_finished_spans())
    turn = spans["voice.turn"]
    assert attrs(turn)["voice.adapter.class"] == "TwilioAgentAdapter"
    assert parent_id(spans["voice.audio.send"]) == ctx_id(turn)
    assert parent_id(spans["voice.audio.receive"]) == ctx_id(turn)


# --- T2 (connect attrs) ---------------------------------------------------------


@pytest.mark.asyncio
async def test_t2_connect_span_carries_twilio_phone_and_config_attrs(monkeypatch):
    """T2: after connect(), voice.adapter.connect carries the Twilio config
    attrs that ARE knowable at connect() time: phone_number_sid (resolved via
    REST), validate_signature + webhook_port (construction-time config).

    FLAGGED, not silently resolved: the design doc's Tier-1 bullet also lists
    ``voice.twilio.direction`` as a connect()-span attribute, but connect() is
    direction-agnostic — ``_mode`` stays "idle" until place_call()/
    wait_for_call() is invoked, and that choice happens AFTER this span has
    already closed (the design doc's own dial-span analysis: "you cannot
    stamp attributes onto a closed span"). The constructor has no direction
    param either. So ``voice.twilio.direction`` cannot be a real
    voice.adapter.connect attribute; it is tested on voice.adapter.dial
    instead (see T4/T5 below), where it IS architecturally knowable. Encoding
    it here would pin an impossible contract rather than catch a real gap —
    see the final report for this flag.
    """
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0, validate_signature=True)
    executor = _exec(adapter)

    await executor._voice_connect_all()
    try:
        connect = _by_name(exporter.get_finished_spans())["voice.adapter.connect"]
        assert attrs(connect)["voice.adapter.class"] == "TwilioAgentAdapter"
        assert attrs(connect)["voice.twilio.phone_number_sid"] == "PN" + "0" * 32
        assert attrs(connect)["voice.twilio.validate_signature"] is True
        assert attrs(connect)["voice.twilio.webhook_port"] == 0
    finally:
        await executor._voice_disconnect_all()


# --- T3 (disconnect counters) ---------------------------------------------------


@pytest.mark.asyncio
async def test_t3_disconnect_carries_frame_and_dtmf_counters_and_stop_reason(
    monkeypatch,
):
    """T3: after a call with N=3 media frames + M=2 DTMF ending in a "stop"
    frame, voice.adapter.disconnect carries frames_received==3,
    dtmf_received==2, stream_ended_reason=="stop". The fake WS serves a fixed
    deterministic script (not real timing), so the counts are exact and
    non-flaky."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()

    frames = [
        _start_frame(),
        build_media_frame(STREAM_SID, bytes([0x7F]) * 160),
        build_media_frame(STREAM_SID, bytes([0x7F]) * 160),
        build_media_frame(STREAM_SID, bytes([0x7F]) * 160),
        _dtmf_frame("1"),
        _dtmf_frame("5"),
        _stop_frame(),
    ]
    await drive_twilio_production(adapter, _ScriptedWS(frames))
    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert int_attr(disconnect, "voice.twilio.frames_received") == 3
    assert int_attr(disconnect, "voice.twilio.dtmf_received") == 2
    assert attrs(disconnect)["voice.twilio.stream_ended_reason"] == "stop"


@pytest.mark.asyncio
async def test_t3_disconnect_stream_ended_reason_is_close_on_socket_disconnect(
    monkeypatch,
):
    """T3 (enum member): a socket close with no "stop" frame records
    reason=='close'."""
    from starlette.websockets import WebSocketDisconnect

    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()

    ws = _ScriptedWS([_start_frame()], close_with=WebSocketDisconnect(code=1000))
    await drive_twilio_production(adapter, ws)  # swallowed inside run_stream_session
    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.twilio.stream_ended_reason"] == "close"


@pytest.mark.asyncio
async def test_t3_disconnect_stream_ended_reason_is_error_on_transport_exception(
    monkeypatch,
):
    """T3 (enum member): a non-disconnect transport error records
    reason=='error'."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()

    ws = _ScriptedWS(
        [_start_frame()], close_with=RuntimeError("boom: transport failure")
    )
    with pytest.raises(RuntimeError, match="boom: transport failure"):
        await drive_twilio_production(adapter, ws)
    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.twilio.stream_ended_reason"] == "error"


@pytest.mark.asyncio
async def test_t3_disconnect_stream_ended_reason_is_none_when_no_call_ran(
    monkeypatch,
):
    """T3 (enum member): connect() + disconnect() with no media session at all
    records reason=='none' — the media loop never engaged."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.twilio.stream_ended_reason"] == "none"


@pytest.mark.asyncio
async def test_t3_disconnect_carries_webhook_invocation_and_rejection_counts(
    monkeypatch,
):
    """T3 (webhook visibility delta): one unsigned (403, rejected) + one
    validly-signed (200, accepted) POST to /twilio/voice -> disconnect
    carries webhook_invocations==2, webhook_rejected==1. This is what makes a
    misconfigured-webhook stream_connect_timeout diagnosable without a direct
    webhook span (design doc's D-hazard note)."""
    from fastapi.testclient import TestClient
    from twilio.request_validator import RequestValidator

    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    auth_token = "the-shared-secret"
    adapter = _make_adapter(
        http_port=0, validate_signature=True, auth_token=auth_token
    )
    executor = _exec(adapter)
    await executor._voice_connect_all()

    assert adapter.public_base_url is not None
    app = adapter._build_app()
    client = TestClient(app, base_url=adapter.public_base_url)

    r1 = client.post("/twilio/voice", data={"From": "+14155551234"})
    assert r1.status_code == 403  # unsigned -> rejected

    url = adapter.public_base_url.rstrip("/") + "/twilio/voice"
    params = {"From": "+14155551234"}
    signature = RequestValidator(auth_token).compute_signature(url, params)
    r2 = client.post(
        "/twilio/voice", data=params, headers={"X-Twilio-Signature": signature}
    )
    assert r2.status_code == 200  # validly signed -> accepted

    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert int_attr(disconnect, "voice.twilio.webhook_invocations") == 2
    assert int_attr(disconnect, "voice.twilio.webhook_rejected") == 1


@pytest.mark.asyncio
async def test_t3_disconnect_rest_restore_failed_is_false_on_clean_restore(
    monkeypatch,
):
    """T3: a normal answer-mode restore on disconnect reports
    rest_restore_failed==False."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()
    assert adapter._stream_connected is not None
    adapter._stream_connected.set()
    await adapter.wait_for_call(timeout=1.0)

    await executor._voice_disconnect_all()

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.twilio.rest_restore_failed"] is False


@pytest.mark.asyncio
async def test_t3_disconnect_rest_restore_failed_is_true_when_rest_restore_raises(
    monkeypatch,
):
    """T3: when the REST voice_url restore raises (a Twilio outage),
    disconnect() still completes (the existing ``suppress(Exception)``
    swallow), but now reports rest_restore_failed==True so the swallowed
    failure is no longer invisible."""
    exporter = _install_in_memory_provider()
    rest_instances = _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    executor = _exec(adapter)
    await executor._voice_connect_all()
    assert adapter._stream_connected is not None
    adapter._stream_connected.set()
    await adapter.wait_for_call(timeout=1.0)

    rest = rest_instances[0]
    original_write = rest.write_voice_url

    def _flaky_write(sid: str, url: str) -> None:
        original_write(sid, url)
        if len(rest.write_calls) == 2:  # the restore call, not the initial set
            raise RuntimeError("simulated Twilio REST outage")

    rest.write_voice_url = _flaky_write  # type: ignore[method-assign]

    await executor._voice_disconnect_all()  # must not raise despite the injected failure

    disconnect = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert attrs(disconnect)["voice.twilio.rest_restore_failed"] is True


# --- T4 / T5 (dial OK) -----------------------------------------------------------


@pytest.mark.asyncio
async def test_t4_dial_span_ok_outbound_place_call(monkeypatch):
    """T4: placeCall() over a mocked REST + a pre-fired stream-connect signal
    emits ONE voice.adapter.dial span, OK, direction=='outbound', call_sid
    set, stream_connect_latency_ms present, and does NOT carry
    dial_outcome=='stream_connect_timeout' (negative discriminator)."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        assert adapter._stream_connected is not None
        adapter._stream_connected.set()  # pre-fire: stream "already" connected
        await adapter.place_call(to="+14155557777")

        dial_spans = [
            s for s in exporter.get_finished_spans() if s.name == "voice.adapter.dial"
        ]
        assert len(dial_spans) == 1
        dial = dial_spans[0]
        assert dial.status.status_code != StatusCode.ERROR
        assert attrs(dial)["voice.adapter.class"] == "TwilioAgentAdapter"
        assert attrs(dial)["voice.twilio.direction"] == "outbound"
        assert attrs(dial)["voice.twilio.call_sid"] == "CA" + "1" * 32
        assert "voice.twilio.stream_connect_latency_ms" in attrs(dial)
        assert attrs(dial).get("voice.twilio.dial_outcome") != "stream_connect_timeout"
        # PII note (flagged in the final report): asserted redaction-tolerantly —
        # passes whether the eventual impl stores the raw E.164 or a
        # _redact_e164-style last-4 form.
        assert attrs(dial)["voice.twilio.to"].endswith("7777")
        assert attrs(dial)["voice.twilio.from"].endswith("1234")
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_t5_dial_span_ok_inbound_wait_for_call(monkeypatch):
    """T5: waitForCall() emits voice.adapter.dial, direction=='inbound'."""
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        assert adapter._stream_connected is not None
        adapter._stream_connected.set()
        await adapter.wait_for_call(timeout=1.0)

        dial = _by_name(exporter.get_finished_spans())["voice.adapter.dial"]
        assert dial.status.status_code != StatusCode.ERROR
        assert attrs(dial)["voice.twilio.direction"] == "inbound"
    finally:
        await adapter.disconnect()


# --- T6 (dial ERROR, marquee: stream_connect_timeout) ----------------------------


@pytest.mark.asyncio
async def test_t6_dial_span_error_on_stream_connect_timeout(monkeypatch):
    """T6 (MARQUEE): the media stream never connects (Twilio's Media Streams
    WS never opens back to us — e.g. a misconfigured/rejected webhook). The
    EXISTING asyncio.TimeoutError still raises (regression-safe); NEW:
    voice.adapter.dial is ERROR with
    voice.twilio.dial_outcome=='stream_connect_timeout'. This is the
    "I placed the call but no media ever streamed" story the epic exists for.
    """
    exporter = _install_in_memory_provider()
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        # Do NOT set _stream_connected — place_call must time out.
        with pytest.raises(asyncio.TimeoutError):
            await adapter.place_call(to="+14155557777", timeout=0.05)

        dial = _by_name(exporter.get_finished_spans())["voice.adapter.dial"]
        assert dial.status.status_code == StatusCode.ERROR
        assert attrs(dial)["voice.twilio.dial_outcome"] == "stream_connect_timeout"
    finally:
        await adapter.disconnect()


# --- T7 (dial ERROR, REST failure — original exception) --------------------------


@pytest.mark.asyncio
async def test_t7_dial_span_error_on_rest_failure_records_original_exception(
    monkeypatch,
):
    """T7: a REST failure inside placeCall() marks voice.adapter.dial ERROR
    and records the ORIGINAL exception (not a re-wrapped one) — both via the
    span status description (``type(exc).__name__``, the ``voice_span``
    convention) and the recorded exception event's exception.type /
    exception.message."""
    exporter = _install_in_memory_provider()
    rest_instances = _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        def _boom(*, to: str, from_: str, twiml: str) -> str:
            raise RuntimeError("Twilio REST: rate limited")

        rest_instances[0].place_call = _boom  # type: ignore[method-assign]

        with pytest.raises(RuntimeError, match="rate limited"):
            await adapter.place_call(to="+14155557777")

        dial = _by_name(exporter.get_finished_spans())["voice.adapter.dial"]
        assert dial.status.status_code == StatusCode.ERROR
        assert dial.status.description == "RuntimeError"
        exception_events = [e for e in dial.events if e.name == "exception"]
        assert exception_events, "expected span.record_exception on the dial span"
        assert exception_events[-1].attributes is not None
        assert exception_events[-1].attributes["exception.type"] == "RuntimeError"
        assert "rate limited" in str(exception_events[-1].attributes["exception.message"])
    finally:
        await adapter.disconnect()


# --- T8 (never-break safety) ------------------------------------------------------


class _BoomProcessor(SimpleSpanProcessor):
    def on_end(self, span):  # noqa: D401 - a misbehaving processor
        if span.name == "voice.adapter.dial":
            raise RuntimeError("simulated span-export failure")


@pytest.mark.asyncio
async def test_t8_dial_span_export_failure_never_breaks_a_successful_place_call(
    monkeypatch, caplog
):
    """T8: a SpanProcessor.on_end that throws at the dial site is swallowed
    (WARNING logged via the scenario.voice logger), the run continues, and
    placeCall still returns its real (successful) result. Mirrors the
    existing A7 guard test (test_voice_spans.py) applied to the new dial
    site."""
    provider = TracerProvider()
    provider.add_span_processor(_BoomProcessor(InMemorySpanExporter()))
    trace.set_tracer_provider(provider)
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        assert adapter._stream_connected is not None
        adapter._stream_connected.set()
        with caplog.at_level(logging.WARNING, logger="scenario.voice"):
            await adapter.place_call(to="+14155557777")  # must not raise
        assert adapter._mode == "call"  # the real result still landed
        warnings = [
            r
            for r in caplog.records
            if r.levelno == logging.WARNING
            and r.name == "scenario.voice"
            and "failed to export" in r.getMessage()
        ]
        assert warnings, "expected a scenario.voice WARNING for the swallowed span-end"
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_t8_dial_span_export_failure_does_not_mask_a_real_timeout(monkeypatch):
    """T8 (error-path twin): the same misbehaving processor must not swallow
    or replace a REAL failure — a genuine stream-connect timeout still raises
    asyncio.TimeoutError, unchanged, despite the boom processor at the dial
    site."""
    provider = TracerProvider()
    provider.add_span_processor(_BoomProcessor(InMemorySpanExporter()))
    trace.set_tracer_provider(provider)
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(http_port=0)
    await adapter.connect()
    try:
        with pytest.raises(asyncio.TimeoutError):
            await adapter.place_call(to="+14155557777", timeout=0.05)
    finally:
        await adapter.disconnect()


# --- T9 (py<->ts parity) -----------------------------------------------------------
#
# Not independently testable inside one language's suite. Parity is enforced
# by this file AND javascript/src/voice/adapters/__tests__/twilio-spans.test.ts
# hard-coding the IDENTICAL span name ("voice.adapter.dial") and attribute-key
# strings: "voice.twilio.direction", "voice.twilio.phone_number_sid",
# "voice.twilio.validate_signature", "voice.twilio.webhook_port",
# "voice.twilio.frames_received", "voice.twilio.dtmf_received",
# "voice.twilio.stream_ended_reason", "voice.twilio.rest_restore_failed",
# "voice.twilio.webhook_invocations", "voice.twilio.webhook_rejected",
# "voice.twilio.to", "voice.twilio.from", "voice.twilio.call_sid",
# "voice.twilio.stream_connect_latency_ms", "voice.twilio.dial_outcome". A
# renamed key in either language's implementation fails THAT language's own
# suite — that divergence IS the falsifier.


# --- T10 (no per-frame spans / flood guard) -----------------------------------------


@pytest.mark.asyncio
async def test_t10_voice_span_count_invariant_to_frame_count(monkeypatch):
    """T10: a connect -> media-loop -> disconnect cycle emits NO per-frame
    spans — the voice.* span count from the cycle does not scale with the
    number of media frames driven through it.

    NOTE (honesty flag, not oversold as RED): with only the two lifecycle
    spans in play, this already holds true pre-#775 (2 spans regardless of
    N) — on its own it does not discriminate RED/GREEN for this PR. It is a
    forward flood-guard protecting the T3 counter implementation from
    regressing into a per-frame-span design (mirrors
    test_voice_spans_elevenlabs.py's H1 pump-tick invariant)."""
    _install_fake_rest(monkeypatch)

    async def _run(n_frames: int) -> int:
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()
        exporter = _install_in_memory_provider()
        adapter = _make_adapter(http_port=0)
        executor = _exec(adapter)
        await executor._voice_connect_all()
        frames = (
            [_start_frame()]
            + [
                build_media_frame(STREAM_SID, bytes([0x7F]) * 160)
                for _ in range(n_frames)
            ]
            + [_stop_frame()]
        )
        await drive_twilio_production(adapter, _ScriptedWS(frames))
        await executor._voice_disconnect_all()
        return len(
            [s for s in exporter.get_finished_spans() if s.name.startswith("voice.")]
        )

    few = await _run(3)
    many = await _run(30)
    assert few == many == 2


# --- T11 (Tier 3 — background-loop delivery markers, #781/#774 base) -------------
#
# #781 rebased Twilio onto #774's reusable primitive: base ``call()`` publishes the
# live ``voice.turn`` OTel context onto ``self._voice_turn_context`` (cleared in a
# ``finally``); a background-receive-loop adapter parents a detached-task delivery
# marker span under it via ``voice_span(name, attrs, parent=ctx)``. Mirrors
# ``test_voice_spans_pipecat.py``'s P2 suite one-to-one, swapping
# ``voice.pipecat.recv.source`` -> ``voice.twilio.recv.source`` and Pipecat's
# always-running ``_recv_task``/synchronous-callback-free loop for Twilio's
# ``media_stream_loop`` background task driven here via ``_ControllableWS`` +
# ``drive_twilio_production`` (the same real-production-wrapper seam T1 uses).
#
# Ordering trick (identical to the Pipecat suite, see its P2 docstring): ``call()``
# publishes ``_voice_turn_context`` SYNCHRONOUSLY, before its first genuine
# ``await`` (the frame-pacing ``asyncio.sleep`` inside ``send_audio``, or — for
# a no-incoming turn — the first ``recv_audio`` wait inside the drain). The
# background loop task is already parked on ``receive_text()`` and can only
# resume once ``call()`` actually yields, so a frame pushed into the
# ``_ControllableWS`` queue immediately before ``await drive_call(...)`` is
# decoded by the loop AFTER the turn context is live (T11a/T11b). Pushing the
# frame earlier, with an intervening ``await asyncio.sleep(...)`` BEFORE
# ``call()`` ever starts (T11c/T11d), instead lets the loop decode+enqueue it
# with NO turn live — the complementary case.


@pytest.mark.asyncio
async def test_t11a_background_receive_span_parented_to_turn():
    """T11a (Tier-3 core, mirrors Pipecat P2): the background
    ``media_stream_loop`` task emits a ``voice.audio.receive`` span parented
    DIRECTLY to the live ``voice.turn`` — proving Twilio reuses the #774
    context-capture primitive (the loop task's own ambient OTel context is
    whatever was active when the task was scheduled, NOT the turn — a
    detached/closed-parent span without this). RED: the marker does not exist
    on the pre-Tier-3 adapter."""
    exporter = _install_in_memory_provider()
    adapter = make_connected_twilio_adapter()
    adapter.response_tail_silence = 0.05  # keep the test fast
    ws = _ControllableWS()
    loop_task = asyncio.create_task(drive_twilio_production(adapter, ws))
    ws.push(_start_frame())
    assert adapter._stream_connected is not None
    await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2.0)

    # Push ONE agent-audio frame, THEN IMMEDIATELY start the turn — see the
    # ordering-trick note above.
    ws.push(build_media_frame(STREAM_SID, bytes([0x7F]) * 800))
    user_audio = AudioChunk(data=b"\x00\x00" * 1200)
    await drive_call(adapter, make_agent_input(user_audio))

    ws.push(_stop_frame())
    await asyncio.wait_for(loop_task, timeout=2.0)

    spans = exporter.get_finished_spans()
    turn = _by_name(spans)["voice.turn"]
    bg = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.twilio.recv.source") == "background_loop"
    ]
    assert bg, "expected a background-loop voice.audio.receive span"
    # The core assertion: parented directly under the turn, NOT a
    # detached/closed span (the loop's frozen scheduling-time context).
    assert parent_id(bg[0]) == ctx_id(turn)
    assert int_attr(bg[0], "voice.audio.bytes") > 0


@pytest.mark.asyncio
async def test_t11b_one_background_span_per_turn_not_per_frame():
    """T11b (Tier-3 flood-guard, mirrors Pipecat P2): three separate wire
    deliveries within ONE live turn emit exactly ONE background-loop marker
    span — matching the base's one-receive-span-per-turn granularity and the
    epic's no-per-tick-flood rule (the EL pump H1 / Pipecat P2 precedent).
    RED: today there is no background marker at all (0, not 1)."""
    exporter = _install_in_memory_provider()
    adapter = make_connected_twilio_adapter()
    adapter.response_tail_silence = 0.05
    ws = _ControllableWS()
    loop_task = asyncio.create_task(drive_twilio_production(adapter, ws))
    ws.push(_start_frame())
    assert adapter._stream_connected is not None
    await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2.0)

    for _ in range(3):  # three 800-byte (individually-flushing) frames, one turn
        ws.push(build_media_frame(STREAM_SID, bytes([0x7F]) * 800))
    user_audio = AudioChunk(data=b"\x00\x00" * 1200)
    await drive_call(adapter, make_agent_input(user_audio))

    ws.push(_stop_frame())
    await asyncio.wait_for(loop_task, timeout=2.0)

    bg = [
        s
        for s in _receives(exporter.get_finished_spans())
        if attrs(s).get("voice.twilio.recv.source") == "background_loop"
    ]
    assert len(bg) == 1, f"expected one background span per turn, got {len(bg)}"


@pytest.mark.asyncio
async def test_t11c_prebuffered_turn_has_base_span_but_no_background_marker():
    """T11c (turn-liveness gate boundary, mirrors Pipecat's review-F2 test):
    agent audio delivered and enqueued BEFORE any call() has published a live
    turn context (e.g. audio buffered during connect, before the first turn)
    is later drained by the base drain WITHOUT a fresh wire delivery under
    that turn, so it carries NO background_loop marker — the base
    ``voice.audio.receive`` span still covers its consumption.

    FLAG (mirrors T1/T10's honesty pattern in the earlier report): this
    assertion holds both BEFORE and AFTER a correct Tier-3 implementation —
    nothing here exercises the marker's presence, only its correct absence.
    It is a forward regression guard against an over-eager implementation
    that ignores the turn-liveness gate (spans every delivery unconditionally),
    not a RED discriminator for Tier-3's initial existence. T11a/T11b are the
    RED discriminators for that.
    """
    exporter = _install_in_memory_provider()
    adapter = make_connected_twilio_adapter()
    adapter.response_tail_silence = 0.05
    ws = _ControllableWS()
    loop_task = asyncio.create_task(drive_twilio_production(adapter, ws))
    ws.push(_start_frame())
    assert adapter._stream_connected is not None
    await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2.0)

    ws.push(build_media_frame(STREAM_SID, bytes([0x7F]) * 800))
    await asyncio.sleep(0.05)  # let the loop decode+enqueue with NO turn live

    user_audio = AudioChunk(data=b"\x00\x00" * 1200)
    await drive_call(
        adapter, make_agent_input(user_audio)
    )  # drains the pre-buffered chunk

    ws.push(_stop_frame())
    await asyncio.wait_for(loop_task, timeout=2.0)

    spans = exporter.get_finished_spans()
    base = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.twilio.recv.source") != "background_loop"
    ]
    bg = [
        s
        for s in _receives(spans)
        if attrs(s).get("voice.twilio.recv.source") == "background_loop"
    ]
    assert base, "base drain receive span should still be present"
    assert bg == [], "a pre-buffered turn emits no background marker (by design)"


@pytest.mark.asyncio
async def test_t11d_regression_no_background_span_between_turns():
    """T11d (regression, mirrors Pipecat's P-regression test): a frame decoded
    with NO active turn (no call() ever ran) emits NO background span — the
    turn-liveness gate keeps the background media loop from leaking a
    detached/closed-parent span (e.g. a late frame after the turn closed, or
    a pre-turn greeting frame). Also covers the disconnect teardown path.

    FLAG (same caveat as T11c): GREEN both before and after a correct
    implementation — a forward guard against an implementation that spans
    unconditionally, not a RED discriminator for Tier-3's initial existence.
    """
    exporter = _install_in_memory_provider()
    adapter = make_connected_twilio_adapter()
    ws = _ControllableWS()
    loop_task = asyncio.create_task(drive_twilio_production(adapter, ws))
    ws.push(_start_frame())
    assert adapter._stream_connected is not None
    await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2.0)

    # No call() in flight -> _voice_turn_context is None -> the loop buffers
    # the decoded chunk but must emit no span.
    ws.push(build_media_frame(STREAM_SID, bytes([0x7F]) * 800))
    await asyncio.sleep(0.05)  # let the background loop process the frame

    ws.push(_stop_frame())
    await asyncio.wait_for(loop_task, timeout=2.0)

    bg = [
        s
        for s in _receives(exporter.get_finished_spans())
        if attrs(s).get("voice.twilio.recv.source") == "background_loop"
    ]
    assert bg == [], "no background receive span should be emitted between turns"
