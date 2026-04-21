"""
E2E wrapper for Example 6.3 — angry customer in noisy cafe.

AC: judge evaluates empathy, noise-robustness, and resolution.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY")

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples"))


@pytest.mark.skipif(
    any(not os.getenv(k) for k in REQUIRED_ENV),
    reason=f"Requires {REQUIRED_ENV}",
)
@pytest.mark.asyncio
async def test_example_6_3_angry_customer_e2e_success():
    """Scenario with angry customer persona and cafe noise runs without crashing."""
    from voice_example_6_3_angry_customer import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
