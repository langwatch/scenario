"""
Unit tests for OpenAISTTProvider 25-minute chunking (§4.3 L324).

The OpenAI gpt-4o-transcribe API rejects audio longer than 25 minutes per
request. The default STT provider must detect long turns and split them
into sub-25-minute chunks, transcribing each independently and joining.
"""

import pytest

from scenario.voice import AudioChunk
from scenario.voice.stt import (
    OPENAI_TRANSCRIBE_LIMIT_SECONDS,
    OpenAISTTProvider,
)


class _CountingOpenAISTT(OpenAISTTProvider):
    def __init__(self):
        super().__init__()
        self.called_with: list[int] = []

    async def _transcribe_single(self, audio: AudioChunk) -> str:  # type: ignore[override]
        self.called_with.append(len(audio.data))
        return f"seg{len(self.called_with)}"


@pytest.mark.asyncio
async def test_transcribe_audio_under_25_min_single_call():
    provider = _CountingOpenAISTT()
    short = AudioChunk(data=b"\x00\x00" * 24000)  # 1 second
    out = await provider.transcribe(short)
    assert out == "seg1"
    assert len(provider.called_with) == 1


@pytest.mark.asyncio
async def test_transcribe_audio_over_25_min_chunks_and_concatenates():
    provider = _CountingOpenAISTT()
    # 26 minutes of PCM16 @ 24kHz mono. 2 bytes/sample.
    long_duration_s = 26 * 60
    long = AudioChunk(data=b"\x00\x00" * (24000 * long_duration_s))
    out = await provider.transcribe(long)
    # Must have called the single-chunk path more than once.
    assert len(provider.called_with) >= 2
    # Each sub-chunk must be <= the 25 minute limit.
    for byte_len in provider.called_with:
        sample_count = byte_len // 2
        assert sample_count <= 24000 * OPENAI_TRANSCRIBE_LIMIT_SECONDS
    # Transcripts are joined with single spaces.
    assert out == " ".join(f"seg{i}" for i in range(1, len(provider.called_with) + 1))
