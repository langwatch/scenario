"""
Unit tests verifying that Phase 2 stub adapters fail loudly (PendingTransportError)
rather than silently producing empty audio.

The capability matrix advertises what each adapter WILL support when its real
transport lands; ``send_audio`` / ``recv_audio`` must raise clearly so scenario
authors who accidentally run an @unit test against a stub adapter get a sharp
failure, not a silent no-op.

Transports shipped in this PR (removed from STUB_ADAPTERS):
    - TwilioAgentAdapter (real Media Streams transport shipped)
    - PipecatAgentAdapter(transport="websocket") (real WS transport shipped;
      webrtc mode still raises PendingTransportError — covered below).
    - ElevenLabsAgentAdapter (real Conversational AI WebSocket transport shipped).
    - OpenAIRealtimeAgentAdapter (real Realtime WebSocket transport shipped).
    - GeminiLiveAgentAdapter (real Live API transport shipped).
"""

import pytest

from scenario.voice import (
    AudioChunk,
    LiveKitAgentAdapter,
    PipecatAgentAdapter,
    VapiAgentAdapter,
    WebRTCAgentAdapter,
)
from scenario.voice.adapters import PendingTransportError


# Adapters whose send/recv still stub out fully after `connect()`.
# Out of this list as of this PR:
#   - TwilioAgentAdapter (real Media Streams transport shipped)
#   - PipecatAgentAdapter(transport="websocket") (real WS transport shipped;
#     webrtc mode still raises PendingTransportError — covered below).
#   - ElevenLabsAgentAdapter (real Conversational AI WebSocket transport shipped).
#   - OpenAIRealtimeAgentAdapter (real Realtime WebSocket transport shipped).
#   - GeminiLiveAgentAdapter (real Live API transport shipped).
STUB_ADAPTERS = [
    (LiveKitAgentAdapter, {"url": "wss://x", "api_key": "k", "api_secret": "s", "room": "r"}),
    (VapiAgentAdapter, {"assistant_id": "a", "api_key": "k"}),
    (WebRTCAgentAdapter, {"signaling_url": "https://x"}),
]


@pytest.mark.parametrize("cls,kwargs", STUB_ADAPTERS)
@pytest.mark.asyncio
async def test_send_audio_raises_pending_transport_after_connect(cls, kwargs):
    adapter = cls(**kwargs)
    await adapter.connect()
    with pytest.raises(PendingTransportError) as excinfo:
        await adapter.send_audio(AudioChunk(data=b"\x00\x00" * 1200))
    assert cls.__name__ in str(excinfo.value)


@pytest.mark.parametrize("cls,kwargs", STUB_ADAPTERS)
@pytest.mark.asyncio
async def test_recv_audio_raises_pending_transport_after_connect(cls, kwargs):
    adapter = cls(**kwargs)
    await adapter.connect()
    with pytest.raises(PendingTransportError):
        await adapter.recv_audio(timeout=0.1)


@pytest.mark.asyncio
async def test_pipecat_webrtc_still_raises_pending_transport():
    """WebRTC mode is a follow-up; calling connect() must fail loud."""
    adapter = PipecatAgentAdapter(transport="webrtc", signaling_url="https://x/api/offer")
    with pytest.raises(PendingTransportError) as excinfo:
        await adapter.connect()
    assert "webrtc" in str(excinfo.value).lower()
