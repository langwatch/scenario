"""
A-leg media-stream WebSocket authentication (scenario#762 Slice 2, guardrail (a)).

In b-leg mode the signed ``POST /twilio/voice`` webhook precedes the socket, so
the socket inherits that trust. In a-leg mode the socket is the ONLY inbound
signal, so a leaked tunnel URL would otherwise be audio injection into a live
PSTN call. ``place_call`` mints a per-call CSPRNG nonce into the origination
TwiML and the media loop closes any socket that cannot present it.

Binds AC5 (nonce), AC6 (callSid correlation) and AC13 (per-call nonce entropy)
of ``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-stream-auth.test.ts``.
"""

import asyncio
import json
import re
from contextlib import suppress
from typing import Any, Optional

import pytest

from scenario.voice import TwilioAgentAdapter
from scenario.voice.adapters._twilio_shared import STREAM_NONCE_HEX_LEN
from scenario.voice.adapters._twilio_server import TwilioWebhookServer

from .test_twilio_adapter import _install_fake_rest, _make_adapter


#: The SID ``FakeREST.place_call`` returns — the call a-leg mode originated.
ORIGINATED_CALL_SID = "CA" + "1" * 32
NONCE_RE = re.compile(r'<Parameter name="nonce" value="([^"]+)"/>')


def _start_frame(
    *,
    nonce: Optional[str],
    call_sid: str = ORIGINATED_CALL_SID,
    stream_sid: str = "MZ762",
) -> str:
    """A Twilio ``start`` frame, optionally carrying a ``nonce`` custom parameter."""
    start: dict[str, Any] = {"streamSid": stream_sid, "callSid": call_sid}
    if nonce is not None:
        start["customParameters"] = {"nonce": nonce}
    return json.dumps({"event": "start", "start": start})


class _ScriptedWS:
    """Media-stream socket double: serves ``frames`` in order, then blocks.

    Blocking (rather than raising) at exhaustion models a socket Twilio holds
    open, so a test can assert that a rejected socket is CLOSED by the loop
    rather than merely running out of frames.
    """

    def __init__(self, frames: list[str]) -> None:
        self._frames = list(frames)
        self._idx = 0
        self.closed = False
        self.sent: list[str] = []

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if self._idx < len(self._frames):
            msg = self._frames[self._idx]
            self._idx += 1
            return msg
        await asyncio.Event().wait()  # held open; never resolves
        raise AssertionError("unreachable")  # pragma: no cover

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def close(self) -> None:
        self.closed = True


async def _place_a_leg_call(a: TwilioAgentAdapter, rest: Any) -> str:
    """Run an a-leg ``place_call`` and return the nonce it put in the TwiML."""
    assert a._stream_connected is not None
    # place_call waits for the stream; this test drives the socket afterwards,
    # so pre-set the event and clear it once the TwiML has been captured.
    a._stream_connected.set()
    await a.place_call(to="+447911123456", attach_stream="a-leg")
    a._stream_connected.clear()
    match = NONCE_RE.search(rest.place_call_kwargs[-1]["twiml"])
    assert match is not None, "a-leg origination TwiML carries no nonce Parameter"
    return match.group(1)


async def _drive(a: TwilioAgentAdapter, ws: _ScriptedWS, timeout: float = 0.2) -> None:
    """Run the media loop over ``ws`` until it returns or parks on the socket.

    A rejected socket makes the loop return on its own; an accepted one parks in
    ``receive_text`` waiting for the next frame, which the timeout cancels. Both
    are expected terminals here — the assertions are on adapter state, not on
    how the loop exited.
    """
    server = TwilioWebhookServer(a)
    task = asyncio.create_task(server.media_stream_loop(ws))
    with suppress(asyncio.TimeoutError):
        await asyncio.wait_for(task, timeout=timeout)


@pytest.mark.asyncio
async def test_a_leg_socket_with_wrong_nonce_is_closed_and_never_connects(monkeypatch):
    """AC5: a mismatched nonce closes the socket and does not signal connected;
    the correct-nonce socket that follows is the one that connects."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        nonce = await _place_a_leg_call(a, rest_instances[0])

        attacker = _ScriptedWS([_start_frame(nonce="not-the-nonce")])
        await _drive(a, attacker)
        assert attacker.closed is True
        assert a._stream_connected is not None
        assert not a._stream_connected.is_set()
        assert a._stream_ws is None  # never adopted as our transport

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        await _drive(a, genuine)
        assert genuine.closed is False
        assert a._stream_connected.is_set()
        assert a._stream_ws is genuine
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_socket_with_no_nonce_parameter_is_closed(monkeypatch):
    """AC5: omitting the <Parameter> is a rejection, not a bypass — enforcement
    is keyed on the mode we originated in, not on the frame carrying a nonce."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        await _place_a_leg_call(a, rest_instances[0])
        ws = _ScriptedWS([_start_frame(nonce=None)])
        await _drive(a, ws)
        assert ws.closed is True
        assert a._stream_connected is not None
        assert not a._stream_connected.is_set()
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_start_frame_with_other_call_sid_is_ignored(monkeypatch):
    """AC6: a correct-nonce frame for a DIFFERENT call is ignored, and the
    connect signal fires exactly once — on the originated SID."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        nonce = await _place_a_leg_call(a, rest_instances[0])
        assert a._call_sid == ORIGINATED_CALL_SID

        stale = _ScriptedWS([_start_frame(nonce=nonce, call_sid="CA" + "9" * 32)])
        await _drive(a, stale)
        assert a._stream_connected is not None
        assert not a._stream_connected.is_set()
        assert a._stream_ws is None

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        await _drive(a, genuine)
        assert a._stream_connected.is_set()
        assert a._stream_sid == "MZ762"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_mints_a_fresh_nonce_per_call(monkeypatch):
    """AC13: two a-leg originations mint DIFFERENT nonces — the assertion a
    hardcoded constant fails. Read from the emitted TwiML, not the minter."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        first = await _place_a_leg_call(a, rest_instances[0])
        a._mode = "idle"  # place_call is once-per-mode; re-arm for a second dial
        second = await _place_a_leg_call(a, rest_instances[0])
    finally:
        await a.disconnect()

    assert first != second
    for nonce in (first, second):
        assert len(nonce) == STREAM_NONCE_HEX_LEN
        assert re.fullmatch(r"[0-9a-f]+", nonce)


@pytest.mark.asyncio
async def test_b_leg_emits_no_parameter_and_still_connects(monkeypatch):
    """Regression: b-leg mints no nonce, so its socket stays un-gated — any
    ``start`` frame connects exactly as it does today."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")  # default b-leg
        a._stream_connected.clear()
        assert "<Parameter" not in rest_instances[0].place_call_kwargs[-1]["twiml"]
        assert a._stream_nonce is None

        ws = _ScriptedWS([_start_frame(nonce=None, call_sid="CA" + "9" * 32)])
        await _drive(a, ws)
        assert ws.closed is False
        assert a._stream_connected.is_set()
        assert a._stream_ws is ws
    finally:
        await a.disconnect()
