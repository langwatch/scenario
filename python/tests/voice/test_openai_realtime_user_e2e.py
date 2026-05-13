"""
E2E wrapper for Demo — OpenAI Realtime as the user simulator.

AC: scripted user("text") lines are delivered with natural prosody;
text TTS is bypassed for the user simulator; result.success is True.

Note: transport is Phase-2 stub; skipped via capability probe on the adapter's
send_audio path (connect/disconnect are wired, but audio I/O raises
PendingTransportError until the real Realtime WebSocket transport ships).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_openai_realtime_user_e2e_success(requires_llm, requires_transport_ready):
    """OpenAI Realtime adapter (USER role) drives simulator; result.success is True."""
    from scenario.voice import OpenAIRealtimeAgentAdapter
    from scenario.voice.audio_chunk import AudioChunk
    from scenario.voice.adapters._stub import PendingTransportError

    # Probe the audio I/O path — connect/disconnect succeed on the stub, but
    # send_audio raises PendingTransportError until the real transport ships.
    adapter = OpenAIRealtimeAgentAdapter()
    await adapter.connect()
    try:
        await adapter.send_audio(AudioChunk(data=b"\x00\x00"))
    except PendingTransportError as exc:
        await adapter.disconnect()
        pytest.skip(f"transport not yet shipped: {exc}")
    except Exception:
        # Probe-only path: send_audio failed for some reason other than
        # PendingTransportError (network, auth, etc). We swallow it here
        # because the real test body below runs against the actual demo
        # script; that will surface a richer error than the probe could.
        pass
    await adapter.disconnect()

    from openai_realtime_user import main  # type: ignore[import]

    result = await main()

    assert result.success, f"Expected success; verdict: {result.reasoning}"
