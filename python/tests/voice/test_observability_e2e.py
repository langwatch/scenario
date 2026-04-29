"""
E2E wrapper for Demo — observability hooks and latency metrics.

AC: both on_audio_chunk and on_voice_event callbacks fired at least once
per turn; result.latency exposes time_to_first_byte, p50, p95.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_observability_e2e_success(requires_llm, requires_pipecat_bot):
    """Observability demo completes; result.success is True."""
    from observability import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"


@pytest.mark.asyncio
async def test_demo_observability_latency_fields_present(requires_llm, requires_pipecat_bot):
    """
    result.latency fields are present when a live bot is connected.
    Skipped when no live bot (latency is None without real audio turns).
    """
    from observability import main  # type: ignore[import]

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
