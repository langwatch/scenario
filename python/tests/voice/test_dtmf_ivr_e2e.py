"""
E2E wrapper for Example 6.4 — DTMF IVR navigation.

Runs end-to-end using two Twilio numbers — no human required.
Both TWILIO_PHONE_NUMBER and TWILIO_PHONE_NUMBER_2 must be Twilio-owned
numbers you control. Missing env → test FAILS (not skips).

AC: DTMF '1' is sent, agent routes to billing, result.success is True.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_example_6_4_dtmf_ivr_e2e_success(requires_twilio_outbound):
    """DTMF '1' is sent, agent routes to billing, scenario succeeds."""
    from dtmf_ivr import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
