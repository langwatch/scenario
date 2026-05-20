"""Unit tests for VoiceAgentAdapter base class."""

import pytest

from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    VoiceAgentAdapter,
    create_audio_message,
)


class _DummyAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self):
        super().__init__()
        self.connected = False
        self.sent: list[AudioChunk] = []
        self._response = AudioChunk(data=b"\x00\x00" * 1200, transcript="hi back")

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def send_audio(self, chunk: AudioChunk) -> None:
        self.sent.append(chunk)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        return self._response


@pytest.mark.asyncio
async def test_connect_disconnect_lifecycle():
    a = _DummyAdapter()
    assert not a.connected
    await a.connect()
    assert a.connected
    await a.disconnect()
    assert not a.connected


@pytest.mark.asyncio
async def test_default_call_sends_audio_and_returns_audio_message():
    # Example 6.5-style: adapter receives audio, sends audio.
    a = _DummyAdapter()
    chunk = AudioChunk(data=b"\x00\x00" * 1200)
    input_msg = create_audio_message(chunk, role="user")

    class _FakeInput:
        new_messages = [input_msg]

    result = await a.call(_FakeInput())  # type: ignore[arg-type]
    assert len(a.sent) == 1
    assert a.sent[0].data == chunk.data
    assert isinstance(result, dict)
    assert result["role"] == "assistant"


def test_capabilities_matrix_is_published():
    a = _DummyAdapter()
    assert isinstance(a.capabilities, AdapterCapabilities)
    assert a.capabilities.streaming_transcripts is True
    assert a.capabilities.native_vad is True
    assert a.capabilities.dtmf is False
