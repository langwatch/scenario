"""
E2E wrapper for Demo — Twilio outbound (simulator calls the agent).

Runs end-to-end using two Twilio numbers — no human required.
Both TWILIO_PHONE_NUMBER and TWILIO_PHONE_NUMBER_2 must be Twilio-owned
numbers you control. Missing env → test FAILS (not skips).

AC: result.success is True after the two-adapter exchange.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_twilio_outbound_e2e_success(requires_twilio_outbound):
    """User-sim dials agent; both sides exchange audio; result.success is True."""
    from twilio_outbound import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
