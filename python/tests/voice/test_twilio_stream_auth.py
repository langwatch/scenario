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
import base64
import json
import re
from contextlib import suppress

import pytest

from scenario.voice.adapters import _twilio_shared
from scenario.voice.adapters._twilio_server import TwilioWebhookServer
from scenario.voice.adapters._twilio_shared import (
    STREAM_NONCE_BYTES,
    STREAM_NONCE_HEX_LEN,
    mint_stream_nonce,
)
from scenario.voice.audio_chunk import AudioChunk

from .a_leg_harness import (
    ORIGINATED_CALL_SID,
    _await_origination,
    _cancel,
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
        nonce, call = await _place_a_leg_call(a, rest_instances[0])

        attacker = _ScriptedWS([_start_frame(nonce="not-the-nonce")])
        async with _driving(a, attacker):
            assert attacker.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None  # never adopted as our transport
        assert not call.done()  # place_call: stream-connected never fired

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine):
            assert genuine.closed is False
            assert a._stream_connected.is_set()
            assert a._stream_ws is genuine
        _ = await call  # the correct-nonce socket is the one that connects
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_socket_connected_before_arming_is_still_gated(monkeypatch):
    """AC5 arming race (CWE-306): a socket that connected BEFORE ``place_call``
    armed the nonce must be gated on the CURRENT nonce when its start frame is
    processed — not on the un-armed state snapshotted at loop entry. Its
    nonceless start frame, arriving after the nonce is armed, is rejected, not
    adopted."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    server = TwilioWebhookServer(a)
    loop = None
    try:
        gate = asyncio.Event()
        early = _ScriptedWS([_start_frame(nonce=None)], gate=gate)
        loop = asyncio.create_task(server.media_stream_loop(early))
        # Let the loop enter and park on the gated first frame BEFORE arming.
        await asyncio.sleep(0)

        nonce, call = await _place_a_leg_call(a, rest_instances[0])
        assert a._stream_nonce is not None

        # Release the nonceless start frame now that enforcement is armed.
        gate.set()
        await asyncio.sleep(0.05)  # let the loop process the delivered frame

        assert early.closed is True, "the pre-arm socket was adopted un-gated"
        assert a._stream_ws is None
        assert a._stream_connected is not None
        assert not a._stream_connected.is_set()
        assert a._stream_ended_reason == "none"

        # The correct-nonce socket that follows is the one that connects.
        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine):
            assert genuine.closed is False
            assert a._stream_connected.is_set()
            assert a._stream_ws is genuine
        _ = await call
    finally:
        if loop is not None and not loop.done():
            loop.cancel()
            with suppress(asyncio.CancelledError):
                _ = await loop
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_socket_adopted_before_dialing_is_evicted(monkeypatch):
    """#762 P1: a nonceless socket adopted AFTER ``connect()`` but BEFORE
    ``place_call`` arms the nonce is bound to an older call generation. When the
    a-leg call is placed, that stale socket is evicted: it must not remain our
    outbound transport, its media must not be enqueued, and its ``stop`` must
    neither end the stream nor cancel the live call's watchdog. ``place_call``
    itself must not resolve until the genuine nonce-authenticated socket's
    ``start``. Twin of the JS regression."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    rest = rest_instances[0]
    server = TwilioWebhookServer(a)

    # A socket double that adopts on its nonceless start, then parks until the
    # test releases its media + stop frames.
    release = asyncio.Event()

    class _EarlyAdoptWS:
        def __init__(self) -> None:
            self._frames = [
                _start_frame(nonce=None),
                json.dumps(
                    {
                        "event": "media",
                        "streamSid": "MZ762",
                        "media": {
                            "payload": base64.b64encode(b"\xff" * 160).decode("ascii")
                        },
                    }
                ),
                json.dumps({"event": "stop"}),
            ]
            self._idx = 0
            self.closed = False
            self.sent: list[str] = []
            self.start_processed = asyncio.Event()

        async def receive_text(self) -> str:
            # After the start frame is served and processed the loop asks again;
            # hold the media/stop frames until the test opens the gate.
            if self._idx == 1:
                self.start_processed.set()
                await release.wait()
            if self._idx < len(self._frames):
                msg = self._frames[self._idx]
                self._idx += 1
                return msg
            await asyncio.Event().wait()  # park
            raise AssertionError("unreachable")  # pragma: no cover

        async def send_text(self, text: str) -> None:
            self.sent.append(text)

        async def close(self) -> None:
            self.closed = True

    early = _EarlyAdoptWS()
    early_loop = asyncio.create_task(server.media_stream_loop(early))
    try:
        # 1. The early nonceless socket adopts un-gated (no nonce armed yet).
        await asyncio.wait_for(early.start_processed.wait(), timeout=2.0)
        assert a._stream_ws is early
        assert a._stream_connected is not None
        assert a._stream_connected.is_set()

        # 2. Placing the a-leg call bumps the generation and resets connection
        #    state: the stale socket is dropped as transport and the stale
        #    connected signal is cleared, so place_call cannot resolve on it.
        nonce, call = await _place_a_leg_call(a, rest)
        assert a._stream_ws is None, "the stale socket stayed our transport"
        assert not a._stream_connected.is_set(), "place_call resolved on a stale signal"
        assert not call.done(), "place_call resolved before a genuine socket"
        watchdog = a._max_duration_task
        assert watchdog is not None

        # 3. Release the stale socket's media + stop. The generation guard closes
        #    it on its next frame; neither the media nor the terminal path may
        #    touch the current call's state.
        release.set()
        await asyncio.wait_for(early_loop, timeout=2.0)
        assert early.closed is True
        assert a._frames_received == 0, "stale socket's media was enqueued"
        assert a._stream_ended is False, "stale socket's stop ended the live stream"
        assert a._max_duration_task is watchdog, "stale socket's stop disarmed the watchdog"
        assert not watchdog.cancelled()

        # 4. The genuine nonce socket is the one that resolves place_call, and one
        #    sent chunk reaches it — never the evicted socket.
        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine, production=True):
            await asyncio.wait_for(call, timeout=2.0)
            assert a._stream_ws is genuine
            await a.send_audio(AudioChunk(data=b"\x00" * 960))
            assert len(genuine.sent) > 0
        assert early.sent == [], "the evicted socket received outbound frames"
    finally:
        if not early_loop.done():
            early_loop.cancel()
            with suppress(asyncio.CancelledError):
                _ = await early_loop
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_media_from_socket_that_never_authenticated_is_not_enqueued(monkeypatch):
    """CWE-306: a socket that skips the authenticated ``start`` must not inject
    audio into the live call. Its ``media`` frames are dropped before the media
    branch runs, so ``_frames_received`` never moves and nothing reaches the
    inbound queue. Without the pre-branch adoption guard an un-adopted socket
    could pump audio straight into the call. Mirrors the JS twin."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        _nonce, call = await _place_a_leg_call(a, rest_instances[0])

        media = json.dumps(
            {
                "event": "media",
                "streamSid": "MZ762",
                "media": {"payload": base64.b64encode(b"\xff" * 160).decode("ascii")},
            }
        )
        attacker = _ScriptedWS([media])
        async with _driving(a, attacker):
            assert a._frames_received == 0, "un-adopted socket injected audio"
            assert a._stream_ws is None
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
        assert not call.done()
        await _cancel(call)
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
        _nonce, call = await _place_a_leg_call(a, rest_instances[0])
        ws = _ScriptedWS([_start_frame(nonce=None)])
        async with _driving(a, ws):
            assert ws.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
        assert not call.done()
        await _cancel(call)
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
        _nonce, call = await _place_a_leg_call(a, rest_instances[0])
        ws = _ScriptedWS([_start_frame(nonce=bad_nonce)])
        async with _driving(a, ws):
            assert ws.closed is True
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None
            assert a._stream_ended_reason == "none"
        assert not call.done()
        await _cancel(call)
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
        nonce, call = await _place_a_leg_call(a, rest_instances[0])
        assert a._call_sid == ORIGINATED_CALL_SID

        stale = _ScriptedWS([_start_frame(nonce=nonce, call_sid="CA" + "9" * 32)])
        async with _driving(a, stale):
            assert a._stream_connected is not None
            assert not a._stream_connected.is_set()
            assert a._stream_ws is None
        assert not call.done()

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine):
            assert a._stream_connected.is_set()
            assert a._stream_sid == "MZ762"
        _ = await call
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
        first, first_call = await _place_a_leg_call(a, rest_instances[0])
        second, second_call = await _place_a_leg_call(a, rest_instances[0])
        await _cancel(first_call)
        await _cancel(second_call)
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
    rest = rest_instances[0]
    try:
        call = asyncio.create_task(a.place_call(to="+14155557777"))  # default b-leg
        await _await_origination(rest, 1)
        assert "<Parameter" not in rest.place_call_kwargs[-1]["twiml"]
        assert a._stream_nonce is None

        ws = _ScriptedWS([_start_frame(nonce=None, call_sid="CA" + "9" * 32)])
        async with _driving(a, ws):
            assert ws.closed is False
            assert a._stream_connected is not None
            assert a._stream_connected.is_set()
            assert a._stream_ws is ws
        _ = await call
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
        _nonce, call_a = await _place_a_leg_call(a, rest)
        assert a._stream_nonce is not None

        # b-leg on the same adapter: its dial supersedes the pending a-leg dial
        # (bumps the generation), and mints no nonce.
        call_b = asyncio.create_task(a.place_call(to="+14155557777"))
        await _await_origination(rest, 2)
        assert a._stream_nonce is None, "the a-leg nonce outlived its call"

        ws = _ScriptedWS([_start_frame(nonce=None, call_sid="CA" + "9" * 32)])
        async with _driving(a, ws):
            assert ws.closed is False, "the b-leg socket was gated on a stale nonce"
            assert a._stream_connected is not None
            assert a._stream_connected.is_set()

            await a.send_dtmf("123")
            assert rest.dtmf_calls == [(a._call_sid, "123")]
        _ = await call_b
        await _cancel(call_a)
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
        nonce, call = await _place_a_leg_call(a, rest_instances[0])

        genuine = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, genuine, production=True):
            await asyncio.wait_for(call, timeout=2.0)
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
