"""
``TwilioHarness`` wires the a-leg guardrails into the adapter it yields.

The harness is the ONLY production construction of ``allowed_callees`` and
``tunnel_readiness``: every guardrail test builds its adapter by hand, so
deleting both lines from ``TwilioHarness.__aenter__`` leaves the whole
destination-guard suite green while every real operator run silently loses both
guardrails. Same shape as the AC12 spy bug this branch already caught.

Binds AC8/AC9 of ``specs/voice-twilio-a-leg-external.feature`` at the wiring
seam, not the enforcement seam.
"""

from typing import Any

import pytest

from scenario.voice.testing import twilio_harness
from scenario.voice.testing.twilio_harness import TwilioHarness

from .a_leg_harness import A_LEG_DESTINATION
from .test_twilio_adapter import _install_fake_rest


class _StubTunnel:
    """Stand-in for ``CloudflareTunnel``: no subprocess, no network."""

    def __init__(self, *, port: int) -> None:
        self.port = port
        self.public_url = "https://stub.trycloudflare.com"
        self.edge_checks = 0

    async def __aenter__(self) -> "_StubTunnel":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def wait_until_edge_reachable(self) -> None:
        self.edge_checks += 1


@pytest.mark.asyncio
async def test_harness_hands_the_adapter_both_a_leg_guardrails(monkeypatch):
    """The yielded adapter carries the allowlist AND the harness's own tunnel."""
    _install_fake_rest(monkeypatch)
    tunnels: list[_StubTunnel] = []

    def _factory(*, port: int) -> _StubTunnel:
        tunnel = _StubTunnel(port=port)
        tunnels.append(tunnel)
        return tunnel

    monkeypatch.setattr(twilio_harness, "CloudflareTunnel", _factory)

    async with TwilioHarness(
        account_sid="AC" + "0" * 32,
        auth_token="secret",
        phone_number="+14155551234",
        http_port=0,
        allowed_callees=[A_LEG_DESTINATION],
        validate_signature=False,
    ) as adapter:
        assert adapter.allowed_callees == {A_LEG_DESTINATION}
        # Identity, not truthiness: the probe must be the harness's OWN tunnel —
        # it is the only object that knows whether this public URL is live.
        assert adapter.tunnel_readiness is tunnels[0]
        assert adapter.public_base_url == tunnels[0].public_url
