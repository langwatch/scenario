"""
Speech-to-text: pluggable STTProvider interface with an OpenAI default.

Planning-level addition — the source proposal (§4.3 L324) says "automatic
STT of all audio messages (always included)" but never names a provider.
We ship an abstract ``STTProvider`` base class plus a default OpenAI
implementation (``gpt-4o-transcribe``, reuses the existing ``openai`` dep).

Users who prefer Deepgram, Whisper, local inference, etc. implement
``STTProvider`` and set it via ``scenario.configure(stt=MyProvider())``.

The OpenAI default chunks audio longer than 25 minutes per request (the API
hard limit). Transcription happens per turn, so this is rarely triggered.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Optional

from ..config.voice_models import OPENAI_STT_MODEL
from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


class STTProvider(ABC):
    """Abstract base for speech-to-text providers."""

    @abstractmethod
    async def transcribe(self, audio: AudioChunk) -> str:
        """Return a text transcript of the audio chunk."""


# ---------------------------------------------------------------- OpenAI default

OPENAI_TRANSCRIBE_LIMIT_SECONDS = 25 * 60


class OpenAISTTProvider(STTProvider):
    """
    Default STT implementation using OpenAI's ``gpt-4o-transcribe`` model.

    Chunks audio exceeding 25 minutes per request (API hard limit). Chunks are
    transcribed independently and concatenated with single spaces.
    """

    def __init__(self, model: str = OPENAI_STT_MODEL):
        self.model = model

    async def transcribe(self, audio: AudioChunk) -> str:
        if audio.duration_seconds <= OPENAI_TRANSCRIBE_LIMIT_SECONDS:
            return await self._transcribe_single(audio)

        # Chunk: split by sample count into <25min slices.
        samples_per_chunk = OPENAI_TRANSCRIBE_LIMIT_SECONDS * PCM16_SAMPLE_RATE
        bytes_per_chunk = samples_per_chunk * 2  # PCM16 = 2 bytes/sample
        parts: list[str] = []
        for i in range(0, len(audio.data), bytes_per_chunk):
            sub = AudioChunk(data=audio.data[i : i + bytes_per_chunk])
            parts.append(await self._transcribe_single(sub))
        return " ".join(p for p in parts if p)

    async def _transcribe_single(self, audio: AudioChunk) -> str:
        import io

        from openai import AsyncOpenAI

        from .messages import _pcm16_to_wav_bytes

        wav_bytes = _pcm16_to_wav_bytes(audio.data)
        client = AsyncOpenAI()
        buf = io.BytesIO(wav_bytes)
        buf.name = "audio.wav"
        resp = await client.audio.transcriptions.create(
            model=self.model,
            file=buf,
        )
        return getattr(resp, "text", "") or ""


# ---------------------------------------------------------------- ElevenLabs STT

ELEVENLABS_STT_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_STT_MODEL = "scribe_v1"


class ElevenLabsSTTProvider(STTProvider):
    """
    STT implementation backed by the ElevenLabs REST speech-to-text API.

    Uses the ``scribe_v1`` model. Audio is converted from the canonical
    PCM16/24kHz AudioChunk to a WAV byte payload before posting.

    Reads ``ELEVENLABS_API_KEY`` from the environment when ``api_key`` is not
    supplied explicitly.

    Only ``text`` is returned — no ElevenLabs-specific types cross the
    ``STTProvider`` interface boundary.
    """

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY", "")

    def __repr__(self) -> str:  # redact credentials
        return "ElevenLabsSTTProvider(api_key='***')"

    async def transcribe(self, audio: AudioChunk) -> str:
        import logging

        import httpx

        from .messages import _pcm16_to_wav_bytes

        wav_bytes = _pcm16_to_wav_bytes(audio.data)
        async with httpx.AsyncClient() as client:
            response = await client.post(
                ELEVENLABS_STT_ENDPOINT,
                headers={"xi-api-key": self.api_key},
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                data={"model_id": ELEVENLABS_STT_MODEL},
            )
            if response.status_code >= 400:
                # Log detail at DEBUG; keep exception message minimal so response
                # body doesn't end up embedded in trace tooling output.
                logging.getLogger("scenario.voice.stt").debug(
                    "ElevenLabs STT %d: %s",
                    response.status_code,
                    response.text[:300],
                )
                raise RuntimeError(
                    f"ElevenLabs STT HTTP {response.status_code} "
                    "(see DEBUG log for response body)"
                )
            return response.json().get("text", "")


# ---------------------------------------------------------------- global provider

_provider: STTProvider = OpenAISTTProvider()


def set_stt_provider(provider: STTProvider) -> None:
    """Install a custom STT provider. Invoked by scenario.configure(stt=...)."""
    global _provider
    _provider = provider


def get_stt_provider() -> STTProvider:
    return _provider


async def transcribe(audio: AudioChunk) -> str:
    """Convenience wrapper around the globally configured provider."""
    if audio.transcript:
        return audio.transcript
    return await _provider.transcribe(audio)
