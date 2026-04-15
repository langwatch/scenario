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
    ElevenLabsAgent,
    GeminiLiveAgent,
    LiveKitAgent,
    OpenAIRealtimeAgent,
    PipecatAgent,
    TwilioAgent,
    VapiAgent,
    WebRTCAgent,
)
from scenario.voice.adapters import PendingTransportError


STUB_ADAPTERS = [
    (PipecatAgent, {"url": "ws://x/ws"}),
    (LiveKitAgent, {"url": "wss://x", "api_key": "k", "api_secret": "s", "room": "r"}),
    (TwilioAgent, {"phone_number": "+1", "from_number": "+1", "account_sid": "AC", "auth_token": "t"}),
    (ElevenLabsAgent, {"agent_id": "a", "api_key": "k"}),
    (VapiAgent, {"assistant_id": "a", "api_key": "k"}),
    (OpenAIRealtimeAgent, {}),
    (GeminiLiveAgent, {}),
    (WebRTCAgent, {"signaling_url": "https://x"}),
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
