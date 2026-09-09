"""
``send_dtmf`` is refused in a-leg mode (scenario#762 Slice 5, AC10).

``send_dtmf`` works by ``calls(sid).update(twiml=...)``, which REPLACES the
TwiML the live call is executing. Under b-leg the replaced TwiML is a hold on
our own leg and the Media Stream rides the callee's leg, so the redirect is
harmless. Under a-leg the replaced TwiML IS the ``<Connect><Stream>`` carrying
the scenario, so the same REST call would tear down the media session mid-run.

Binds AC10 of ``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-dtmf-guard.test.ts``.
"""

import pytest

from scenario.voice.adapters.twilio import A_LEG_SEND_DTMF_UNSUPPORTED

from .a_leg_harness import (
    _driving,
    _place_a_leg_call,
    _place_call_and_connect,
    _ScriptedWS,
    _start_frame,
)
from .test_twilio_adapter import _install_fake_rest, _make_adapter


@pytest.mark.asyncio
async def test_send_dtmf_in_a_leg_mode_raises_and_leaves_the_stream_alone(monkeypatch):
    """AC10: the refusal names the reason, no TwiML-replace POST is issued, and
    the live socket is still the adapter's transport afterwards."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    rest = rest_instances[0]
    try:
        nonce, call = await _place_a_leg_call(a, rest)
        ws = _ScriptedWS([_start_frame(nonce=nonce)])
        async with _driving(a, ws):
            assert a._stream_ws is ws, "precondition: the a-leg socket is live"

            with pytest.raises(RuntimeError) as excinfo:
                await a.send_dtmf("123")

            assert str(excinfo.value) == A_LEG_SEND_DTMF_UNSUPPORTED
            assert "<Connect><Stream>" in str(excinfo.value), (
                "the refusal must say WHY, not merely that it is unsupported"
            )
            assert rest.dtmf_calls == [], "a-leg must issue zero TwiML-replace POSTs"
            assert ws.closed is False
            assert a._stream_ws is ws
        await call
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_send_dtmf_still_works_in_b_leg_mode(monkeypatch):
    """Regression: b-leg mints no nonce, so the guard stays disarmed and DTMF
    reaches the REST helper exactly as it always has."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    rest = rest_instances[0]
    try:
        await _place_call_and_connect(a, rest, to="+14155557777")  # default b-leg
        assert a._stream_nonce is None

        await a.send_dtmf("123")

        assert rest.dtmf_calls == [(a._call_sid, "123")]
    finally:
        await a.disconnect()
