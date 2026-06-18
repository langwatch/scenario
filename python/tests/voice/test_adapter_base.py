"""Unit tests for VoiceAgentAdapter base class."""

import asyncio
import pytest
from typing import Any, Optional, cast

from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    STTProvider,
    VoiceAgentAdapter,
    create_audio_message,
    get_stt_provider,
    set_stt_provider,
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


# --------------------------------------------------------------------- #
# Runtime STT for transcript-less transports (user-simulator blindness) #
# --------------------------------------------------------------------- #
#
# Transports like Twilio Media Streams (TwilioAgentAdapter,
# PipecatAgentAdapter) carry audio frames only. Before call() grew the
# _ensure_transcript step, the assistant message went into history without
# a text part, the text-only user simulator rendered it as the
# "[audio message]" placeholder, and the simulator replied blind to every
# agent turn — while the judge, transcribing the recording post-hoc, still
# showed a coherent-looking transcript.

class _OneShotAdapter(VoiceAgentAdapter):
    """Audio-only transport: one agent chunk, then silence (drain timeout)."""

    capabilities = AdapterCapabilities(
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self, response: AudioChunk):
        super().__init__()
        self._response: Optional[AudioChunk] = response

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._response is None:
            raise asyncio.TimeoutError
        chunk, self._response = self._response, None
        return chunk


class _CountingSTT(STTProvider):
    def __init__(self, canned: str):
        self.canned = canned
        self.calls = 0

    async def transcribe(self, audio: AudioChunk) -> str:
        self.calls += 1
        return self.canned


class _BoomSTT(STTProvider):
    async def transcribe(self, audio: AudioChunk) -> str:
        raise RuntimeError("stt down")


class _EmptySTT(STTProvider):
    async def transcribe(self, audio: AudioChunk) -> str:
        return ""


def _audio_input():
    msg = create_audio_message(AudioChunk(data=b"\x00\x00" * 1200), role="user")

    class _FakeInput:
        new_messages = [msg]

    return _FakeInput()


def _text_parts(message: Any) -> list[str]:
    return [
        p["text"]
        for p in cast(dict, message)["content"]
        if isinstance(p, dict) and p.get("type") == "text"
    ]


@pytest.mark.asyncio
async def test_default_call_transcribes_transcriptless_agent_audio():
    prev = get_stt_provider()
    fake = _CountingSTT("what's your membership number?")
    set_stt_provider(fake)
    try:
        a = _OneShotAdapter(AudioChunk(data=b"\x00\x00" * 1200))
        result = await a.call(_audio_input())  # type: ignore[arg-type]
        assert _text_parts(result) == ["what's your membership number?"]
        assert fake.calls == 1
    finally:
        set_stt_provider(prev)


@pytest.mark.asyncio
async def test_default_call_skips_stt_when_adapter_ships_transcript():
    prev = get_stt_provider()
    fake = _CountingSTT("must not be used")
    set_stt_provider(fake)
    try:
        a = _OneShotAdapter(AudioChunk(data=b"\x00\x00" * 1200, transcript="hi back"))
        result = await a.call(_audio_input())  # type: ignore[arg-type]
        assert _text_parts(result) == ["hi back"]
        assert fake.calls == 0
    finally:
        set_stt_provider(prev)


@pytest.mark.asyncio
async def test_default_call_returns_audio_only_when_stt_fails():
    prev = get_stt_provider()
    set_stt_provider(_BoomSTT())
    try:
        a = _OneShotAdapter(AudioChunk(data=b"\x00\x00" * 1200))
        result = await a.call(_audio_input())  # type: ignore[arg-type]
        assert _text_parts(result) == []
        assert any(
            isinstance(p, dict) and p.get("type") == "input_audio"
            for p in cast(dict, result)["content"]
        )
    finally:
        set_stt_provider(prev)


@pytest.mark.asyncio
async def test_default_call_returns_audio_only_when_stt_returns_empty():
    prev = get_stt_provider()
    set_stt_provider(_EmptySTT())
    try:
        a = _OneShotAdapter(AudioChunk(data=b"\x00\x00" * 1200))
        result = await a.call(_audio_input())  # type: ignore[arg-type]
        assert _text_parts(result) == []
        assert any(
            isinstance(p, dict) and p.get("type") == "input_audio"
            for p in cast(dict, result)["content"]
        )
    finally:
        set_stt_provider(prev)
