"""
A-leg max call duration (scenario#762 Slice 3, guardrail (b)).

B-leg mode holds the originator leg with ``<Pause length="120"/>``, which caps
the call for free. A-leg mode replaced that with ``<Connect>``, under which the
call lives exactly as long as the WebSocket — so a hung or killed executor would
keep a billing PSTN call open indefinitely. Two independent mechanisms restore
the ceiling: Twilio's own ``TimeLimit`` on ``Calls.create`` (AC12 — the
load-bearing half, it fires even when this process is gone) and an adapter-side
wall-clock timer that hangs the call up via REST and closes the socket (AC7).

Binds AC7 and AC12 of ``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-call-duration.test.ts``.
"""

import asyncio
from contextlib import suppress
from typing import Any

import pytest

from scenario.voice import TwilioAgentAdapter
from scenario.voice.adapters._twilio_shared import (
    DEFAULT_MAX_CALL_DURATION_SECONDS,
    MAX_CALL_DURATION_CAP_SECONDS,
)

from .a_leg_harness import (
    A_LEG_DESTINATION,
    ORIGINATED_CALL_SID,
    _await_origination,
    _cancel,
    _driving,
    _place_call_and_connect,
    _ScriptedWS,
    _start_frame,
)
from .test_twilio_adapter import _install_fake_rest, _make_adapter


class _ControlledExpiry:
    """Stand-in for ``_await_max_duration``: the test decides when time is up.

    Replaces the adapter's sleep seam so expiry is driven by ``release`` rather
    than by a real wall clock — no sleeps, no flake.
    """

    def __init__(self) -> None:
        self.armed = asyncio.Event()
        self.release = asyncio.Event()
        self.seconds: Any = None

    async def __call__(self, seconds: int) -> None:
        self.seconds = seconds
        self.armed.set()
        await self.release.wait()


async def _armed(expiry: _ControlledExpiry) -> None:
    """Wait for the watchdog to arm, failing fast if it never does.

    Without the bound, an adapter that forgets to arm the timer hangs the test
    instead of failing it.
    """
    await asyncio.wait_for(expiry.armed.wait(), timeout=2.0)


async def _connected_adapter(monkeypatch: Any) -> tuple[TwilioAgentAdapter, Any]:
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    assert a._stream_connected is not None
    a._stream_connected.set()  # a-leg's stream still comes to us
    return a, rest_instances[0]


# ---------------------------------------------------------------- AC12: TimeLimit


@pytest.mark.asyncio
async def test_a_leg_place_call_sends_configured_time_limit(monkeypatch):
    """AC12: the configured max duration lands in the Calls.create request."""
    a, rest = await _connected_adapter(monkeypatch)
    try:
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg",
            max_call_duration_seconds=120,
        )
        assert rest.place_call_kwargs[0]["time_limit"] == 120
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_place_call_defaults_time_limit_when_unset(monkeypatch):
    """A caller who names no duration still gets a bounded call."""
    a, rest = await _connected_adapter(monkeypatch)
    try:
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg"
        )
        assert (
            rest.place_call_kwargs[0]["time_limit"]
            == DEFAULT_MAX_CALL_DURATION_SECONDS
        )
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_place_call_above_cap_raises_before_origination(monkeypatch):
    """A request above the global cap is a caller error, never a silent clamp —
    and it is rejected before we dial."""
    a, rest = await _connected_adapter(monkeypatch)
    try:
        with pytest.raises(ValueError, match=f"{MAX_CALL_DURATION_CAP_SECONDS}s cap"):
            await a.place_call(
                to="+447700900123",
                attach_stream="a-leg",
                max_call_duration_seconds=MAX_CALL_DURATION_CAP_SECONDS + 1,
            )
        assert rest.place_call_kwargs == []
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_place_call_non_positive_duration_raises(monkeypatch):
    a, rest = await _connected_adapter(monkeypatch)
    try:
        with pytest.raises(ValueError, match="positive number of seconds"):
            await a.place_call(
                to="+447700900123", attach_stream="a-leg", max_call_duration_seconds=0
            )
        assert rest.place_call_kwargs == []
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_b_leg_rejects_max_call_duration(monkeypatch):
    """The cap is a-leg-only; naming it elsewhere is rejected, not ignored."""
    a, rest = await _connected_adapter(monkeypatch)
    try:
        with pytest.raises(ValueError, match='attach_stream="a-leg"'):
            await a.place_call(to="+14155557777", max_call_duration_seconds=60)
        assert rest.place_call_kwargs == []
    finally:
        await a.disconnect()


# ---------------------------------------------------------------- AC7: timer


@pytest.mark.asyncio
async def test_max_duration_timer_ends_the_originated_call_and_closes_ws(monkeypatch):
    """AC7: on expiry the adapter hangs up the ORIGINATED call via REST and
    closes the socket, with a distinguishable end reason."""
    a, rest = await _connected_adapter(monkeypatch)
    expiry = _ControlledExpiry()
    a._await_max_duration = expiry  # type: ignore[method-assign]
    try:
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg",
            timeout=120.0, max_call_duration_seconds=42,
        )
        ws = _ScriptedWS([])
        a._stream_ws = ws

        await _armed(expiry)
        # The two clocks are independent: the timer got the max-duration value,
        # not place_call's connect timeout.
        assert expiry.seconds == 42
        expiry.release.set()
        assert a._max_duration_task is not None
        await a._max_duration_task

        assert rest.end_calls == [ORIGINATED_CALL_SID]
        assert ws.closed is True
        assert a._stream_ended_reason == "max_duration"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_timer_is_cancelled_by_disconnect_and_never_calls_rest(monkeypatch):
    """Teardown guard: a timer that expires after disconnect() must not hang up
    anything — worst case, a LATER call's SID."""
    a, rest = await _connected_adapter(monkeypatch)
    expiry = _ControlledExpiry()
    a._await_max_duration = expiry  # type: ignore[method-assign]
    await _place_call_and_connect(
        a, rest, to="+447700900123", attach_stream="a-leg",
        max_call_duration_seconds=42,
    )
    task = a._max_duration_task
    assert task is not None
    await _armed(expiry)

    await a.disconnect()

    expiry.release.set()
    with suppress(asyncio.CancelledError):
        _ = await task
    assert task.cancelled(), "disconnect() left the duration timer armed"
    assert rest.end_calls == []


@pytest.mark.asyncio
async def test_timer_is_cancelled_when_the_stream_ends(monkeypatch):
    """The media loop's terminal path disarms the timer, so a call that ended on
    its own cannot be hung up again."""
    from scenario.voice.adapters._twilio_server import TwilioWebhookServer

    a, rest = await _connected_adapter(monkeypatch)
    expiry = _ControlledExpiry()
    a._await_max_duration = expiry  # type: ignore[method-assign]
    try:
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg",
            max_call_duration_seconds=42,
        )
        task = a._max_duration_task
        assert task is not None
        await _armed(expiry)

        # Drive one media session that opens on the originated call and stops.
        import json

        nonce = a._stream_nonce
        frames = [
            json.dumps(
                {
                    "event": "start",
                    "start": {
                        "streamSid": "MZ762",
                        "callSid": ORIGINATED_CALL_SID,
                        "customParameters": {"nonce": nonce},
                    },
                }
            ),
            json.dumps({"event": "stop"}),
        ]

        class _StopWS:
            def __init__(self) -> None:
                self._frames = list(frames)

            async def receive_text(self) -> str:
                return self._frames.pop(0)

            async def close(self) -> None:  # pragma: no cover - never reached
                pass

        await TwilioWebhookServer(a).media_stream_loop(_StopWS())

        expiry.release.set()
        with suppress(asyncio.CancelledError):
            _ = await task
        assert task.cancelled(), "stream end left the duration timer armed"
        assert rest.end_calls == []
        assert a._stream_ended_reason == "stop"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_second_place_call_replaces_the_first_timer(monkeypatch):
    """Re-arming cancels the previous timer, so an older call's watchdog can
    never hang up a newer call's SID."""
    a, rest = await _connected_adapter(monkeypatch)
    expiry_one = _ControlledExpiry()
    a._await_max_duration = expiry_one  # type: ignore[method-assign]
    try:
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg",
            max_call_duration_seconds=42,
        )
        first = a._max_duration_task
        assert first is not None
        await _armed(expiry_one)

        expiry_two = _ControlledExpiry()
        a._await_max_duration = expiry_two  # type: ignore[method-assign]
        await _place_call_and_connect(
            a, rest, to="+447700900123", attach_stream="a-leg",
            max_call_duration_seconds=42,
        )
        await _armed(expiry_two)
        assert a._max_duration_task is not first

        expiry_one.release.set()
        with suppress(asyncio.CancelledError):
            _ = await first
        assert first.cancelled()
        assert rest.end_calls == []
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_expired_watchdog_in_flight_does_not_close_a_newer_calls_socket(monkeypatch):
    """#762 P2: call A's watchdog fires and its hang-up REST call is IN FLIGHT
    when call B takes over on the same adapter. When A's response finally
    resolves, its handler must close only the EXPIRED call's socket — never
    whatever socket is live now. Here that live socket is B's, so releasing A's
    held hang-up must leave B's socket open.

    The existing cancellation tests only cover expiry BEFORE the handler starts;
    this drives the re-arm/takeover WHILE the hang-up is already awaiting.

    A second a-leg dial cancels A's asyncio task outright, so — to exercise the
    handler resuming past its in-flight hang-up, the JS twin's un-cancellable
    scenario — B is a b-leg dial: it bumps the call generation (evicting A's
    claim on the socket) without arming, and so does not cancel A's task.
    """
    import threading

    a, rest = await _connected_adapter(monkeypatch)
    a_sid = "CA" + "a" * 32
    b_sid = "CB" + "b" * 32

    # Distinct SIDs for A then B.
    sids = iter([a_sid, b_sid])

    def _place(*, to, from_, twiml, time_limit=None):
        rest.place_call_kwargs.append(
            {"to": to, "from_": from_, "twiml": twiml, "time_limit": time_limit}
        )
        return next(sids)

    rest.place_call = _place  # type: ignore[method-assign]

    # Hold A's hang-up REST response until the test releases it.
    end_gate = threading.Event()

    def _end(call_sid):
        rest.end_calls.append(call_sid)
        if call_sid == a_sid:
            end_gate.wait()

    rest.end_call = _end  # type: ignore[method-assign]

    expiry_a = _ControlledExpiry()
    a._await_max_duration = expiry_a  # type: ignore[method-assign]

    call_a = None
    call_b = None
    try:
        # 1. Place a-leg call A and arm its watchdog.
        call_a = asyncio.create_task(
            a.place_call(
                to=A_LEG_DESTINATION, attach_stream="a-leg",
                timeout=120.0, max_call_duration_seconds=42,
            )
        )
        await _await_origination(rest, 1)
        await _armed(expiry_a)
        assert a._call_sid == a_sid

        # 2. Expire A; its hang-up blocks in flight on end_gate.
        expiry_a.release.set()
        for _ in range(2000):
            if a_sid in rest.end_calls:
                break
            await asyncio.sleep(0.001)
        assert rest.end_calls == [a_sid], "A's watchdog never reached the hang-up"

        # 3. B takes over (bumps the generation) and its socket goes live.
        call_b = asyncio.create_task(a.place_call(to="+14155557777"))  # b-leg
        await _await_origination(rest, 2)
        assert a._call_sid == b_sid
        assert a._stream_nonce is None

        genuine_b = _ScriptedWS([_start_frame(nonce=None, call_sid=b_sid)])
        async with _driving(a, genuine_b, production=True):
            await asyncio.wait_for(call_b, timeout=2.0)
            assert a._stream_ws is genuine_b

            # 4. Release A's held hang-up. Its handler resumes, sees a newer
            #    generation, and must leave B's socket alone.
            end_gate.set()
            await asyncio.sleep(0.05)

            assert genuine_b.closed is False, "A's expired watchdog closed B's socket"
            assert a._stream_ws is genuine_b
            # Only the expired call was ended; B's live call was not.
            assert rest.end_calls == [a_sid]
    finally:
        end_gate.set()
        if call_a is not None:
            await _cancel(call_a)
        if call_b is not None:
            await _cancel(call_b)
        await a.disconnect()


# ------------------------------------------------- REST wire body (AC12, real helper)


class _RecordingTwilioClient:
    """Twilio SDK client double: records ``calls.create`` and ``calls(sid).update``."""

    def __init__(self) -> None:
        self.create_kwargs: list[dict[str, Any]] = []
        self.updates: list[tuple[str, dict[str, Any]]] = []
        client = self

        class _Call:
            def __init__(self, call_sid: str) -> None:
                self._call_sid = call_sid

            def update(self, **kwargs: Any) -> None:
                client.updates.append((self._call_sid, kwargs))

        class _Calls:
            def create(self, **kwargs: Any) -> Any:
                client.create_kwargs.append(kwargs)
                return type("_Created", (), {"sid": ORIGINATED_CALL_SID})()

            def __call__(self, call_sid: str) -> _Call:
                return _Call(call_sid)

        self.calls = _Calls()


def _rest_helper_with(client: _RecordingTwilioClient) -> Any:
    """Build a TwilioRESTHelper around ``client``, skipping the real SDK client."""
    from scenario.voice.adapters._twilio_shared import TwilioRESTHelper

    helper = TwilioRESTHelper.__new__(TwilioRESTHelper)
    helper._client = client  # type: ignore[attr-defined]
    return helper


def test_rest_place_call_passes_time_limit_to_calls_create():
    """AC12 on the real helper: the configured seconds reach Twilio's request,
    not just the adapter's call to this method."""
    client = _RecordingTwilioClient()
    _rest_helper_with(client).place_call(
        to="+447700900123", from_="+14155551234", twiml="<Response/>", time_limit=300
    )
    assert client.create_kwargs == [
        {
            "to": "+447700900123",
            "from_": "+14155551234",
            "twiml": "<Response/>",
            "time_limit": 300,
        }
    ]


def test_rest_place_call_omits_time_limit_when_unset():
    """B-leg's request body is byte-identical to what it has always been."""
    client = _RecordingTwilioClient()
    _rest_helper_with(client).place_call(
        to="+14155557777", from_="+14155551234", twiml="<Response/>"
    )
    assert "time_limit" not in client.create_kwargs[0]


def test_rest_end_call_completes_the_call():
    client = _RecordingTwilioClient()
    _rest_helper_with(client).end_call(ORIGINATED_CALL_SID)
    assert client.updates == [(ORIGINATED_CALL_SID, {"status": "completed"})]


# ------------------------------------------------- stream-connect timeout


@pytest.mark.asyncio
async def test_a_leg_stream_connect_timeout_hangs_the_call_up(monkeypatch):
    """The ordinary a-leg failure path must not bill for the whole cap.

    When the media stream never connects, the call is ALREADY originated and the
    watchdog armed — so without an explicit hangup the caller gets their
    TimeoutError while Twilio keeps the PSTN call alive to
    ``max_call_duration_seconds``.
    """
    a, rest = await _connected_adapter(monkeypatch)
    assert a._stream_connected is not None
    a._stream_connected.clear()  # nothing will drive a socket
    try:
        with pytest.raises(asyncio.TimeoutError):
            await a.place_call(
                to=A_LEG_DESTINATION, attach_stream="a-leg", timeout=0.05
            )
        assert rest.end_calls == [ORIGINATED_CALL_SID]
        assert a._max_duration_task is None, "the watchdog outlived the call it capped"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_b_leg_stream_connect_timeout_hangs_nothing_up(monkeypatch):
    """b-leg holds the originator leg with <Pause>, which bounds it already — the
    hangup stays a-leg-only so b-leg's failure path is byte-for-byte unchanged."""
    a, rest = await _connected_adapter(monkeypatch)
    assert a._stream_connected is not None
    a._stream_connected.clear()
    try:
        with pytest.raises(asyncio.TimeoutError):
            await a.place_call(to="+14155557777", timeout=0.05)
        assert rest.end_calls == []
    finally:
        await a.disconnect()
