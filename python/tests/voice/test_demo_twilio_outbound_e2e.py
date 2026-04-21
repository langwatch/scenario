"""
E2E wrapper for Demo — Twilio outbound (agent calls a human).

AC: callee answers, Media Streams WS opens, result.success is True.

This is a human-in-the-loop demo. The e2e test skips without INTEGRATION_MANUAL=1
(a human must answer the outbound call).
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
    "TARGET_PHONE_NUMBER",
)

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.skipif(
    not os.getenv("INTEGRATION_MANUAL"),
    reason="Requires INTEGRATION_MANUAL=1 (human must answer the outbound call)",
)
@pytest.mark.asyncio
async def test_demo_twilio_outbound_e2e_success():
    """Outbound Twilio call connects and DTMF is received."""
    from voice_demo_twilio_outbound import main  # type: ignore[import]

    # The outbound demo exits via sys.exit(0/1), not returning a result.
    # We wrap in try/except SystemExit to treat exit(0) as success.
    try:
        await main()
    except SystemExit as exc:
        assert exc.code == 0, f"Outbound demo exited with code {exc.code} (failure)"
