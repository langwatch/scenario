"""Unit tests for the pluggable STTProvider interface."""

import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scenario.voice import (
    AudioChunk,
    ElevenLabsSTTProvider,
    STTProvider,
    get_stt_provider,
    set_stt_provider,
    transcribe,
)


class FakeSTT(STTProvider):
    """Records every audio it gets asked to transcribe."""

    def __init__(self, canned: str = "canned transcript"):
        self.canned = canned
        self.calls: list[AudioChunk] = []

    async def transcribe(self, audio: AudioChunk) -> str:
        self.calls.append(audio)
        return self.canned


@pytest.mark.asyncio
async def test_set_stt_provider_is_used_by_transcribe():
    prev = get_stt_provider()
    fake = FakeSTT()
    set_stt_provider(fake)
    try:
        chunk = AudioChunk(data=b"\x00\x00" * 1200)
        result = await transcribe(chunk)
        assert result == "canned transcript"
        assert len(fake.calls) == 1
    finally:
        set_stt_provider(prev)


@pytest.mark.asyncio
async def test_transcribe_uses_existing_transcript_when_present():
    prev = get_stt_provider()
    fake = FakeSTT(canned="should not be called")
    set_stt_provider(fake)
    try:
        chunk = AudioChunk(data=b"\x00\x00" * 1200, transcript="already transcribed")
        result = await transcribe(chunk)
        assert result == "already transcribed"
        assert fake.calls == []
    finally:
        set_stt_provider(prev)


def test_stt_provider_is_abstract():
    with pytest.raises(TypeError):
        STTProvider()  # type: ignore[abstract]


# ---------------------------------------------------------------- ElevenLabsSTTProvider

def test_elevenlabs_stt_provider_implements_interface():
    """ElevenLabsSTTProvider must be an STTProvider with no ElevenLabs types leaking."""
    provider = ElevenLabsSTTProvider(api_key="test")
    assert isinstance(provider, STTProvider)

    # Verify the method signature matches the abstract interface exactly.
    sig = inspect.signature(provider.transcribe)
    params = list(sig.parameters.values())
    # Should have exactly one parameter: audio.
    assert len(params) == 1
    assert params[0].name == "audio"

    # The annotation must reference AudioChunk, not any ElevenLabs type.
    annotation = params[0].annotation
    assert annotation is AudioChunk or annotation == "AudioChunk"

    # Return annotation must be str (or "str").
    ret = sig.return_annotation
    assert ret is str or ret == "str"


def test_elevenlabs_stt_provider_repr_redacts_key():
    provider = ElevenLabsSTTProvider(api_key="very_secret")
    assert "very_secret" not in repr(provider)
    assert "***" in repr(provider)


@pytest.mark.asyncio
async def test_elevenlabs_stt_provider_transcribe():
    """POST to the ElevenLabs STT endpoint; return the ``text`` field."""
    provider = ElevenLabsSTTProvider(api_key="test_key")
    chunk = AudioChunk(data=b"\x00\x00" * 1200)

    # Build a fake response with the JSON the real endpoint returns.
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json = MagicMock(return_value={"text": "hello"})

    # httpx.AsyncClient.post is a coroutine; patch it as AsyncMock.
    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=fake_response)):
        result = await provider.transcribe(chunk)

    assert result == "hello"


@pytest.mark.asyncio
async def test_elevenlabs_stt_provider_reads_env_key(monkeypatch):
    """Falls back to ELEVENLABS_API_KEY env var when api_key not supplied."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "env_key")
    provider = ElevenLabsSTTProvider()
    assert provider.api_key == "env_key"
