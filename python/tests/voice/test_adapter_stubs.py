"""
Unit tests verifying that Phase 2 stub adapters fail loudly (PendingTransportError)
rather than silently producing empty audio.

The capability matrix advertises what each adapter WILL support when its real
transport lands; ``send_audio`` / ``recv_audio`` must raise clearly so scenario
authors who accidentally run an @unit test against a stub adapter get a sharp
failure, not a silent no-op.
"""

import pytest

from scenario.voice import (
    AudioChunk,
    ElevenLabsAgentAdapter,
    GeminiLiveAgentAdapter,
    LiveKitAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    PipecatAgentAdapter,
    VapiAgentAdapter,
    WebRTCAgentAdapter,
)
from scenario.voice.adapters import PendingTransportError


# TwilioAgentAdapter has a REAL transport as of this PR — it's no longer
# a stub and doesn't belong in this parametrize list.
STUB_ADAPTERS = [
    (PipecatAgentAdapter, {"url": "ws://x/ws"}),
    (LiveKitAgentAdapter, {"url": "wss://x", "api_key": "k", "api_secret": "s", "room": "r"}),
    (ElevenLabsAgentAdapter, {"agent_id": "a", "api_key": "k"}),
    (VapiAgentAdapter, {"assistant_id": "a", "api_key": "k"}),
    (OpenAIRealtimeAgentAdapter, {}),
    (GeminiLiveAgentAdapter, {}),
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
