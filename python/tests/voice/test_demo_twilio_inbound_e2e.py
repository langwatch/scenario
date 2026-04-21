"""
E2E wrapper for Demo — Twilio inbound (human dials in).

AC: Media Streams WS opens and result.success is True after one turn.

This is a human-in-the-loop demo. The e2e test skips without INTEGRATION_MANUAL=1
(a human must physically dial the Twilio number).
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
    reason="Requires INTEGRATION_MANUAL=1 (human must dial the Twilio number)",
)
@pytest.mark.asyncio
async def test_demo_twilio_inbound_e2e_success():
    """Inbound Twilio call is answered; result.success is True."""
    from voice_demo_twilio_inbound import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
