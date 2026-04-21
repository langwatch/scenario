"""
E2E wrapper for Demo — observability hooks and latency metrics.

AC: both on_audio_chunk and on_voice_event callbacks fired at least once
per turn; result.latency exposes time_to_first_byte, p50, p95.
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
@pytest.mark.asyncio
async def test_demo_observability_e2e_success():
    """Observability demo completes; result.success is True."""
    from voice_demo_observability import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_demo_observability_latency_fields_present():
    """
    result.latency fields are present when a live bot is connected.
    Skipped when no live bot (latency is None without real audio turns).
    """
    from voice_demo_observability import main  # type: ignore[import]

    result = await main()

    if result.latency is None:
        pytest.skip("No live bot; result.latency is None")

    assert hasattr(result.latency, "time_to_first_byte"), (
        "result.latency must have time_to_first_byte"
    )
    assert hasattr(result.latency, "p50_response_time"), (
        "result.latency must have p50_response_time"
    )
    assert hasattr(result.latency, "p95_response_time"), (
        "result.latency must have p95_response_time"
    )
