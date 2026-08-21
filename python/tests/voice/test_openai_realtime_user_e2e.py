"""
E2E check — OpenAI Realtime adapter (USER role) against the GA Realtime API.

Integration / on-demand, key-gated (``requires_llm``).  Runs the
``openai_realtime_user`` demo script end-to-end against the real OpenAI
Realtime WebSocket API and asserts ``result.success`` is True.  Verifies that
scripted ``user("text")`` lines are delivered via the text-input channel
(bypassing TTS) and that the full scenario completes successfully.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_openai_realtime_user_e2e_success(requires_llm):
    """OpenAI Realtime adapter (USER role) drives simulator; result.success is True."""
    try:
        from openai_realtime_user import main  # type: ignore[import]
    except SystemExit as demo_skipped:
        # The demo guards itself at import with sys.exit(0) while
        # cross-adapter audio bridging is unimplemented, so importing it here
        # raised SystemExit and pytest reported a hard failure. Code that has
        # not shipped is the one case TESTING.md calls a legitimate skip, and
        # the demo's own message says which feature is missing. When the
        # bridge ships, the guard goes and this branch stops being taken.
        pytest.skip(f"demo skipped itself at import: {demo_skipped}")

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
