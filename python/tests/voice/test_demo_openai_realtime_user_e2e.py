"""
E2E wrapper for Demo — OpenAI Realtime as the user simulator.

AC: scripted user("text") lines are delivered with natural prosody;
text TTS is bypassed for the user simulator; result.success is True.

Note: transport is Phase-2 stub; gated on OPENAI_REALTIME_ENABLED=1.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY",)

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.skipif(
    not os.getenv("OPENAI_REALTIME_ENABLED"),
    reason="Requires OPENAI_REALTIME_ENABLED=1 (Realtime transport is Phase-2 stub)",
)
@pytest.mark.asyncio
async def test_demo_openai_realtime_user_e2e_success():
    """OpenAI Realtime adapter (USER role) drives simulator; result.success is True."""
    from voice_demo_openai_realtime_user import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
