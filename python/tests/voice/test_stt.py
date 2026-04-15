"""Unit tests for the pluggable STTProvider interface."""

import pytest

from scenario.voice import AudioChunk, STTProvider, get_stt_provider, set_stt_provider, transcribe


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
