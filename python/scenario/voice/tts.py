"""
Text-to-speech router and cache.

The TTS side uses litellm-style ``provider/voice_name`` routing (e.g.
``openai/nova``, ``elevenlabs/rachel``). Per the TTS cache key locked decision
the cache key is ``(text, voice)`` only; audio effects are applied AFTER a
cache hit and are never baked into the cached audio.

Users can register additional providers via ``register_tts_provider(...)``.
The default set covers OpenAI (hard dep) and lazy-imports ElevenLabs /
Google / Cartesia only when their provider prefix is actually used.
"""

from __future__ import annotations

import asyncio
import functools
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, Tuple

from ..cache import scenario_cache
from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


TTSCallable = Callable[[str, str], Awaitable[bytes]]
"""(text, voice_name) -> PCM16 @ 24kHz mono bytes"""


_PROVIDERS: Dict[str, TTSCallable] = {}


def register_tts_provider(prefix: str, synth: TTSCallable) -> None:
    """Register a TTS backend under the given provider prefix."""
    _PROVIDERS[prefix.lower()] = synth


def _split_voice(voice: str) -> Tuple[str, str]:
    if "/" not in voice:
        raise ValueError(
            f"Voice string {voice!r} must be in 'provider/name' format, e.g. 'openai/nova'"
        )
    provider, name = voice.split("/", 1)
    return provider.lower(), name


# ---------------------------------------------------------------- default TTS

async def _openai_tts(text: str, voice: str) -> bytes:
    """Default OpenAI TTS provider. Uses gpt-4o-mini-tts for short clips."""
    import io
    from openai import AsyncOpenAI

    client = AsyncOpenAI()
    # PCM format means raw PCM16 @ 24kHz mono — matches our internal AudioChunk.
    response = await client.audio.speech.create(
        model="gpt-4o-mini-tts",
        voice=voice,
        input=text,
        response_format="pcm",
    )
    audio_bytes = await response.aread() if hasattr(response, "aread") else response.read()
    return audio_bytes


def _register_default_providers() -> None:
    register_tts_provider("openai", _openai_tts)
    # Lazy imports — only attempt the import when the prefix is used.
    async def _elevenlabs(text: str, voice: str) -> bytes:  # noqa: E306
        try:
            from elevenlabs.client import AsyncElevenLabs  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "elevenlabs provider requires `pip install elevenlabs`"
            ) from exc
        client = AsyncElevenLabs()
        chunks = []
        async for chunk in await client.text_to_speech.convert(
            voice_id=voice,
            text=text,
            output_format="pcm_24000",
        ):
            chunks.append(chunk)
        return b"".join(chunks)

    register_tts_provider("elevenlabs", _elevenlabs)

    async def _google(text: str, voice: str) -> bytes:  # noqa: E306
        try:
            from google.cloud import texttospeech  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "google provider requires `pip install google-cloud-texttospeech`"
            ) from exc
        client = texttospeech.TextToSpeechAsyncClient()
        synth_input = texttospeech.SynthesisInput(text=text)
        voice_cfg = texttospeech.VoiceSelectionParams(
            language_code="-".join(voice.split("-")[:2]) or "en-US",
            name=voice,
        )
        audio_cfg = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=PCM16_SAMPLE_RATE,
        )
        resp = await client.synthesize_speech(
            input=synth_input, voice=voice_cfg, audio_config=audio_cfg
        )
        return bytes(resp.audio_content)

    register_tts_provider("google", _google)

    async def _cartesia(text: str, voice: str) -> bytes:  # noqa: E306
        try:
            from cartesia import AsyncCartesia  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "cartesia provider requires `pip install cartesia`"
            ) from exc
        client = AsyncCartesia()
        raw = await client.tts.bytes(
            model_id="sonic-english",
            transcript=text,
            voice_id=voice,
            output_format={
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": PCM16_SAMPLE_RATE,
            },
        )
        return raw


_register_default_providers()


# ------------------------------------------------------------ cached synthesis

@dataclass(frozen=True)
class _TTSKey:
    text: str
    voice: str


async def _synthesize_raw(text: str, voice: str) -> bytes:
    provider, name = _split_voice(voice)
    if provider not in _PROVIDERS:
        raise ValueError(
            f"Unknown TTS provider {provider!r}. Known: {sorted(_PROVIDERS)}"
        )
    return await _PROVIDERS[provider](text, name)


# joblib cache is sync, but we only call synth once per (text, voice). Cache
# at the PCM-bytes level keyed exclusively on (text, voice) — per the locked
# decision, effects are NEVER baked into the cached audio.
@scenario_cache()
def _cached_synthesize_sync(text: str, voice: str) -> bytes:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_synthesize_raw(text, voice))
    finally:
        loop.close()


async def synthesize(text: str, voice: str) -> AudioChunk:
    """
    Synthesize ``text`` into an AudioChunk using the voice provider.

    Cache key is ``(text, voice)``. Effects must be applied by the caller on
    the returned chunk — they are never part of the cache key.
    """
    # Run the sync cached call in a thread so we don't block the event loop.
    pcm = await asyncio.to_thread(_cached_synthesize_sync, text, voice)
    return AudioChunk(data=pcm)
