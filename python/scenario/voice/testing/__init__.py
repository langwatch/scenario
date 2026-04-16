"""
Test-harness helpers for voice adapters that need public HTTP/S endpoints
(webhooks, WebSockets) — specifically ``TwilioAgentAdapter``.

Not imported by default from ``scenario.voice``. Users opt-in via
``from scenario.voice.testing import CloudflareTunnel, TwilioHarness``.
"""

from __future__ import annotations

from .tunnel import CloudflareTunnel, TunnelUnavailableError

__all__ = ["CloudflareTunnel", "TunnelUnavailableError"]
