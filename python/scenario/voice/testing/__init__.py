"""
Test-harness helpers for voice adapters that need public HTTP/S endpoints
(webhooks, WebSockets) — specifically ``TwilioAgentAdapter``.

Not imported by default from ``scenario.voice``. Users opt-in via
``from scenario.voice.testing import CloudflareTunnel, TwilioHarness``.
"""

from __future__ import annotations

from .tunnel import CloudflareTunnel, TunnelUnavailableError
from .twilio_harness import TwilioHarness

__all__ = ["CloudflareTunnel", "TunnelUnavailableError", "TwilioHarness"]
