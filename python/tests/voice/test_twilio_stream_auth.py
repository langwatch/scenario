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

import re

import pytest

from scenario.voice.adapters import _twilio_shared
from scenario.voice.adapters._twilio_shared import (
    STREAM_NONCE_BYTES,
    STREAM_NONCE_HEX_LEN,
    mint_stream_nonce,
)

from .a_leg_harness import (
    ORIGINATED_CALL_SID,
    _driving,
    _place_a_leg_call,
    _ScriptedWS,
    _start_frame,
)
from .test_twilio_adapter import _install_fake_rest, _make_adapter


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
        async with _driving(a, attacker):
            assert attacker.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None  # never adopted as our transport

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine):
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
        async with _driving(a, ws):
            assert ws.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
    finally:
        await a.disconnect()


@pytest.mark.parametrize(
    "bad_nonce",
    [
        pytest.param("é" * STREAM_NONCE_HEX_LEN, id="non-ascii"),
        pytest.param("0" * (STREAM_NONCE_HEX_LEN * 4), id="over-long"),
    ],
)
@pytest.mark.asyncio
async def test_a_leg_socket_with_malformed_nonce_is_rejected(monkeypatch, bad_nonce):
    """AC5: a nonce the comparison primitive cannot even ingest is a REJECTION.

    ``secrets.compare_digest`` raises ``TypeError`` on a non-ASCII ``str``, so
    before the byte-comparison fix a socket sending ``{"nonce":"é"}`` made the
    auth check fail open into an exception that unwound through the media loop
    — stamping the LIVE call's ended-reason on the way out — instead of closing
    the attacker's socket.
    """
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        await _place_a_leg_call(a, rest_instances[0])
        ws = _ScriptedWS([_start_frame(nonce=bad_nonce)])
        async with _driving(a, ws):
            assert ws.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None
            assert a._stream_ended_reason == "none"
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
        async with _driving(a, stale):
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine):
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
        second = await _place_a_leg_call(a, rest_instances[0])
    finally:
        await a.disconnect()

    assert first != second
    for nonce in (first, second):
        assert len(nonce) == STREAM_NONCE_HEX_LEN
        assert re.fullmatch(r"[0-9a-f]+", nonce)


def test_nonce_comes_from_the_os_csprng(monkeypatch):
    """AC13: the nonce's PROVENANCE, not merely its shape.

    Differentness, length and hex charset all survive a regression from
    ``secrets.token_hex`` to ``random.getrandbits`` — so none of them is
    evidence the value is cryptographically random. Assert the CSPRNG call
    itself.
    """
    calls: list[int] = []

    def _spy(nbytes: int) -> str:
        calls.append(nbytes)
        return "ab" * nbytes

    monkeypatch.setattr(_twilio_shared.secrets, "token_hex", _spy)

    assert mint_stream_nonce() == "ab" * STREAM_NONCE_BYTES
    assert calls == [STREAM_NONCE_BYTES]


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
        async with _driving(a, ws):
            assert ws.closed is False
            assert a._stream_connected.is_set()
            assert a._stream_ws is ws
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_then_b_leg_on_the_same_adapter_still_connects(monkeypatch):
    """A b-leg dial after an a-leg dial must not inherit the a-leg nonce.

    ``_stream_nonce`` arms BOTH media-stream nonce enforcement and the a-leg
    ``send_dtmf`` refusal. A b-leg ``start`` frame carries no ``<Parameter>`` at
    all, so a leaked nonce closes the b-leg socket and the call never connects —
    while ``send_dtmf`` refuses a call it has no reason to refuse. Repeat
    ``place_call`` is explicitly supported (``_enter_mode``'s idempotent
    re-entry).
    """
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    rest = rest_instances[0]
    try:
        await _place_a_leg_call(a, rest)
        assert a._stream_nonce is not None

        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")  # b-leg on the same adapter
        a._stream_connected.clear()
        assert a._stream_nonce is None, "the a-leg nonce outlived its call"

        ws = _ScriptedWS([_start_frame(nonce=None, call_sid="CA" + "9" * 32)])
        async with _driving(a, ws):
            assert ws.closed is False, "the b-leg socket was gated on a stale nonce"
            assert a._stream_connected.is_set()

            await a.send_dtmf("123")
            assert rest.dtmf_calls == [(a._call_sid, "123")]
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_unauthenticated_socket_cannot_clear_the_live_transport(monkeypatch):
    """Anyone who knows the public URL can open ``/twilio/stream`` and close it.

    The production wrapper's ``finally`` nulls ``_stream_ws``/``_stream_sid``,
    so without an identity guard that stranger's socket tears the transport out
    from under the GENUINE call — no nonce required, repeatable at will — and
    every later ``send_audio``/``interrupt``/``recv_audio`` raises while the
    PSTN call keeps billing. Driven through ``run_stream_session``, because the
    bare loop never touches the transport and so cannot show the bug.
    """
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        nonce = await _place_a_leg_call(a, rest_instances[0])

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine, production=True):
            assert a._stream_ws is genuine
            assert a._stream_sid == "MZ762"

            attacker = _ScriptedWS([], disconnect_at_end=True)
            async with _driving(a, attacker, production=True):
                pass

            assert a._stream_ws is genuine, "an attacker socket cleared the transport"
            assert a._stream_sid == "MZ762"
            assert a._stream_ended_reason == "none"
            a._assert_stream_live()  # send_audio/interrupt still work
    finally:
        await a.disconnect()
