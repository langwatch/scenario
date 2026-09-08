"""
A-leg destination allowlist + tunnel readiness (scenario#762 Slice 4, guardrail (c)).

``allowed_callers`` gates who may dial IN. A-leg mode dials OUT to numbers this
Twilio account does not own, so an unguarded ``to`` is an unbounded dialer:
destinations are deny-by-default via ``allowed_callees``. The same
pre-origination slot also probes that our public URL is live at the edge —
otherwise Twilio dials out, opens the media socket against a dead tunnel, and
the caller pays for a call that ends in a confusing stream-connect timeout.

Binds AC8 (allowlist) and AC9 (tunnel readiness) of
``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-destination-guard.test.ts``.
"""

from typing import Any, Optional

import pytest

from scenario.voice import TunnelNotReadyError, TwilioAgentAdapter

from .test_twilio_adapter import _install_fake_rest, _make_adapter


#: The one number the a-leg tests are allowed to dial.
ALLOWED = "+447700900123"


class _FakeTunnel:
    """Readiness probe double, recording WHEN it was consulted.

    ``originations_at_probe`` is the number of ``Calls.create`` calls already
    issued when the probe ran — the assertion that readiness is checked
    *before* origination, not merely somewhere inside ``place_call``. Never
    touches the network; the real edge probe is exercised only by the
    env-gated live smoke.
    """

    def __init__(self, rest_instances: list, error: Optional[Exception] = None) -> None:
        self._rest_instances = rest_instances
        self._error = error
        self.calls = 0
        self.originations_at_probe: Optional[int] = None

    async def wait_until_edge_reachable(self) -> None:
        self.calls += 1
        self.originations_at_probe = len(self._rest_instances[0].place_call_kwargs)
        if self._error is not None:
            raise self._error


async def _connected(
    monkeypatch: Any, *, tunnel_error: Optional[Exception] = None, **overrides: Any
):
    """Connected adapter, its FakeREST, the connect()-time REST offset, and the
    readiness-probe double every test wires in."""
    rest_instances = _install_fake_rest(monkeypatch)
    tunnel = _FakeTunnel(rest_instances, error=tunnel_error)
    a = _make_adapter(http_port=0, tunnel_readiness=tunnel, **overrides)
    await a.connect()
    rest = rest_instances[0]
    assert a._stream_connected is not None
    # place_call waits for the media stream; nothing drives a socket here.
    a._stream_connected.set()
    return a, rest, len(rest.rest_call_log), tunnel


def _assert_nothing_dialed(rest: Any, base_log: int, adapter: TwilioAgentAdapter) -> None:
    """No origination, no other REST traffic, no nonce minted."""
    assert rest.place_call_kwargs == [], "a refused destination still originated a call"
    assert rest.rest_call_log[base_log:] == [], "a refused destination still hit Twilio REST"
    assert adapter._stream_nonce is None, "a refused destination still minted a nonce"


# ------------------------------------------------------------------ AC8

@pytest.mark.asyncio
async def test_a_leg_default_deny_without_allowed_callees(monkeypatch):
    """AC8: no allowed_callees at all — a-leg refuses before origination."""
    a, rest, base_log, tunnel = await _connected(monkeypatch, allowed_callees=None)
    try:
        with pytest.raises(ValueError, match="requires allowed_callees"):
            await a.place_call(to=ALLOWED, attach_stream="a-leg")
        _assert_nothing_dialed(rest, base_log, a)
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_refuses_destination_absent_from_allowed_callees(monkeypatch):
    """AC8: allowlist set, but this destination is not on it."""
    a, rest, base_log, tunnel = await _connected(monkeypatch, allowed_callees=[ALLOWED])
    try:
        with pytest.raises(ValueError, match="not in allowed_callees"):
            await a.place_call(to="+14155557777", attach_stream="a-leg")
        _assert_nothing_dialed(rest, base_log, a)
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_allows_destination_on_allowed_callees(monkeypatch):
    """AC8 (positive): the allowlisted destination originates normally."""
    a, rest, _, tunnel = await _connected(monkeypatch, allowed_callees=[ALLOWED])
    try:
        await a.place_call(to=ALLOWED, attach_stream="a-leg")
        assert len(rest.place_call_kwargs) == 1
        assert rest.place_call_kwargs[0]["to"] == ALLOWED
    finally:
        await a.disconnect()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "allowed,to",
    [
        ([ALLOWED], "+4477009001"),        # `to` is a PREFIX of an allowed entry
        ([ALLOWED], "+7700900123"),        # `to` is a SUFFIX of an allowed entry
        (["+4477009001"], ALLOWED),        # an allowed entry is a PREFIX of `to`
    ],
    ids=["to-is-prefix", "to-is-suffix", "entry-is-prefix"],
)
async def test_a_leg_refuses_near_miss_destinations(monkeypatch, allowed, to):
    """A substring relationship is not membership — exact match or refusal."""
    a, rest, base_log, tunnel = await _connected(monkeypatch, allowed_callees=allowed)
    try:
        with pytest.raises(ValueError, match="not in allowed_callees"):
            await a.place_call(to=to, attach_stream="a-leg")
        _assert_nothing_dialed(rest, base_log, a)
    finally:
        await a.disconnect()


def test_constructor_rejects_non_e164_allowed_callee():
    """A typo in the allowlist fails at setup, not at dial time."""
    with pytest.raises(ValueError, match="E.164"):
        _make_adapter(allowed_callees=["447700900123"])


@pytest.mark.asyncio
async def test_b_leg_is_unaffected_by_an_unset_allowed_callees(monkeypatch):
    """Regression: b-leg can only reach numbers this account owns, which is its
    own guardrail — it is never gated on allowed_callees."""
    a, rest, _, tunnel = await _connected(monkeypatch, allowed_callees=None)
    try:
        await a.place_call(to="+14155557777")  # default b-leg
        assert len(rest.place_call_kwargs) == 1
        assert rest.place_call_kwargs[0]["to"] == "+14155557777"
    finally:
        await a.disconnect()


# ------------------------------------------------------------------ AC9

@pytest.mark.asyncio
async def test_a_leg_unreachable_tunnel_raises_before_origination(monkeypatch):
    """AC9: an unreachable public URL is a named error, not a billed dead call."""
    a, rest, base_log, tunnel = await _connected(
        monkeypatch,
        allowed_callees=[ALLOWED],
        tunnel_error=RuntimeError("edge did not resolve"),
    )
    try:
        with pytest.raises(TunnelNotReadyError, match="not reachable from the edge"):
            await a.place_call(to=ALLOWED, attach_stream="a-leg")
        assert tunnel.calls == 1
        _assert_nothing_dialed(rest, base_log, a)
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_a_leg_probes_the_tunnel_before_originating(monkeypatch):
    """AC9 (ordering): a reachable edge lets the call through, and the probe ran
    while zero calls had been originated."""
    a, rest, _, tunnel = await _connected(monkeypatch, allowed_callees=[ALLOWED])
    try:
        await a.place_call(to=ALLOWED, attach_stream="a-leg")
        assert tunnel.calls == 1
        assert tunnel.originations_at_probe == 0
        assert len(rest.place_call_kwargs) == 1
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_refused_destination_never_reaches_the_tunnel_probe(monkeypatch):
    """Check order: the free local allowlist check runs before the probe."""
    a, rest, base_log, tunnel = await _connected(
        monkeypatch,
        allowed_callees=[ALLOWED],
        tunnel_error=RuntimeError("edge did not resolve"),
    )
    try:
        with pytest.raises(ValueError, match="not in allowed_callees"):
            await a.place_call(to="+14155557777", attach_stream="a-leg")
        assert tunnel.calls == 0
        _assert_nothing_dialed(rest, base_log, a)
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_b_leg_does_not_probe_the_tunnel(monkeypatch):
    """b-leg's stream arrives via the callee's rewritten webhook, and b-leg has
    always run without a readiness probe — the probe stays a-leg-only."""
    a, rest, _, tunnel = await _connected(
        monkeypatch,
        allowed_callees=[ALLOWED],
        tunnel_error=RuntimeError("edge did not resolve"),
    )
    try:
        await a.place_call(to="+14155557777")  # default b-leg
        assert tunnel.calls == 0
        assert len(rest.place_call_kwargs) == 1
    finally:
        await a.disconnect()
