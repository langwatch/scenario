"""
E2E wrapper for Example 6.4 — DTMF IVR navigation.

AC: agent routes to billing and result.success is True.
This demo requires a live Twilio account; skipped without all Twilio env vars.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = (
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "OPENAI_API_KEY",
)

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.skipif(
    not os.getenv("INTEGRATION_MANUAL"),
    reason="Requires INTEGRATION_MANUAL=1 (human must dial in)",
)
@pytest.mark.asyncio
async def test_example_6_4_dtmf_ivr_e2e_success():
    """DTMF '1' is sent, agent routes to billing, scenario succeeds."""
    from voice_example_6_4_dtmf_ivr import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
