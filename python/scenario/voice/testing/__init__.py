"""
Test-harness helpers for voice adapters.

Two families live here, neither imported by default from ``scenario.voice``:

- Public-endpoint helpers (``CloudflareTunnel``, ``TwilioHarness``) for adapters
  that need public HTTP/S endpoints (webhooks, WebSockets) — specifically
  ``TwilioAgentAdapter``.
- The wrapper harness (``drive_call`` / ``make_agent_input`` plus the Twilio
  real-route helpers) that drives an agent turn through the REAL production
  ``adapter.call()`` wrapper — the tier-1 seam that catches bugs which only
  manifest in the outermost production entry point (see PR #697 and
  ``wrapper_harness`` for the rationale).

Users opt-in via e.g. ``from scenario.voice.testing import CloudflareTunnel,
TwilioHarness`` or ``from scenario.voice.testing import drive_call,
make_agent_input``.
"""

from __future__ import annotations

from .tunnel import CloudflareTunnel, TunnelUnavailableError
from .twilio_harness import TwilioHarness
from .wrapper_harness import (
    drive_call,
    drive_twilio_production,
    free_port,
    make_agent_input,
    make_connected_twilio_adapter,
    serve_real_twilio_route,
    wait_for_twilio_stream_teardown,
)

__all__ = [
    "CloudflareTunnel",
    "TunnelUnavailableError",
    "TwilioHarness",
    "drive_call",
    "make_agent_input",
    "make_connected_twilio_adapter",
    "serve_real_twilio_route",
    "drive_twilio_production",
    "wait_for_twilio_stream_teardown",
    "free_port",
]
