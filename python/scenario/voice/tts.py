"""
Text-to-speech router and cache.

The TTS side uses litellm-style ``provider/voice_name`` routing (e.g.
``openai/nova``, ``elevenlabs/rachel``). Per the TTS cache key locked decision
the cache key is ``(text, voice)`` only; audio effects are applied AFTER a
cache hit and are never baked into the cached audio.

Security note: joblib serialises function arguments to disk as part of its
caching fingerprint. To keep raw user-supplied text out of the cache payload,
``synthesize()`` hashes ``text`` to a stable SHA-256 digest before handing it
to the cached helper. The effective cache key is ``(sha256(text), voice)`` —
equivalent determinism, no plaintext at rest.

Users can register additional providers via ``register_tts_provider(...)``.
The default set covers OpenAI (hard dep) and lazy-imports ElevenLabs /
Google / Cartesia only when their provider prefix is actually used.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from typing import Awaitable, Callable, Dict, Tuple

from ..config.voice_models import OPENAI_TTS_MODEL
from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


TTSCallable = Callable[[str, str], Awaitable[bytes]]
"""(text, voice_name) -> PCM16 @ 24kHz mono bytes"""


_PROVIDERS: Dict[str, TTSCallable] = {}
# In-process LRU cache keyed on (sha256(text), voice) → PCM16 bytes. Keeping
# the raw text out of the key avoids persisting user-supplied strings in any
# future on-disk layer (security review finding). Bounded to prevent
# unbounded memory growth in long-running processes — a 5-minute clip is
# ~14 MB, so 64 entries caps the cache at ~900 MB even for long utterances.
_CACHE_MAX_ENTRIES = 64
_CACHE: "OrderedDict[Tuple[str, str], bytes]" = OrderedDict()


def clear_cache() -> None:
    """Clear the in-process TTS cache. Used by tests and long-lived processes."""
    _CACHE.clear()


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
    """Default OpenAI TTS provider. Uses OPENAI_TTS_MODEL for short clips.

    OpenAI's ``response_format="pcm"`` is documented as raw PCM16 @ 24kHz mono
    — matching our internal AudioChunk. We validate the byte-length-is-even
    invariant via ``AudioChunk.__post_init__`` when the result flows through
    an AudioChunk; we also trim a trailing odd byte here so a single framing
    glitch from the HTTP stream does not poison the cache.
    """
    from openai import AsyncOpenAI

    client = AsyncOpenAI()
    response = await client.audio.speech.create(
        model=OPENAI_TTS_MODEL,
        voice=voice,
        input=text,
        response_format="pcm",
    )
    data = await response.aread()
    if len(data) % 2 == 1:
        # PCM16 is 2 bytes/sample; an odd trailing byte cannot be played.
        data = data[:-1]
    return data


async def _elevenlabs_tts(text: str, voice: str) -> bytes:
    from elevenlabs.client import AsyncElevenLabs  # type: ignore

    client = AsyncElevenLabs()
    # The convert() call returns an async iterator of PCM chunks directly —
    # do NOT `await` it (that's a TypeError on async_generator).
    #
    # model_id="eleven_v3": v3 is the only EL model that honors inline
    # paralinguistic markers like [shouting], [whispering], [sigh],
    # [laughs] — the SDK default eleven_multilingual_v2 reads them as
    # text, which surfaced in the angry_customer demo where the user
    # simulator said the word "angry" aloud instead of sounding angry.
    chunks: list[bytes] = []
    async for chunk in client.text_to_speech.convert(
        voice_id=voice,
        text=text,
        model_id="eleven_v3",
        output_format="pcm_24000",
    ):
        chunks.append(chunk)
    return b"".join(chunks)


async def _google_tts(text: str, voice: str) -> bytes:
    try:
        from google.cloud import texttospeech  # type: ignore
    except ImportError as exc:  # pragma: no cover — depends on host deps
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


async def _cartesia_tts(text: str, voice: str) -> bytes:
    try:
        from cartesia import AsyncCartesia  # type: ignore
    except ImportError as exc:  # pragma: no cover — depends on host deps
        raise ImportError(
            "cartesia provider requires `pip install cartesia`"
        ) from exc
    client = AsyncCartesia()
    return await client.tts.bytes(
        model_id="sonic-english",
        transcript=text,
        voice_id=voice,
        output_format={
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": PCM16_SAMPLE_RATE,
        },
    )


register_tts_provider("openai", _openai_tts)
register_tts_provider("elevenlabs", _elevenlabs_tts)
register_tts_provider("google", _google_tts)
register_tts_provider("cartesia", _cartesia_tts)


# ------------------------------------------------------------ cached synthesis


async def _synthesize_raw(text: str, voice: str) -> bytes:
    provider, name = _split_voice(voice)
    if provider not in _PROVIDERS:
        raise ValueError(
            f"Unknown TTS provider {provider!r}. Known: {sorted(_PROVIDERS)}"
        )
    return await _PROVIDERS[provider](text, name)


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def synthesize(text: str, voice: str) -> AudioChunk:
    """
    Synthesize ``text`` into an AudioChunk using the voice provider.

    Cache key is ``(sha256(text), voice)`` — equivalent to keying on
    ``(text, voice)`` but without pinning the raw text in the cache payload.
    Effects must be applied by the caller on the returned chunk; they are
    never part of the cache key.
    """
    cache_key = (_hash_text(text), voice)
    cached = _CACHE.get(cache_key)
    if cached is not None:
        _CACHE.move_to_end(cache_key)  # LRU touch
        return AudioChunk(data=cached, transcript=text)
    pcm = await _synthesize_raw(text, voice)
    _CACHE[cache_key] = pcm
    _CACHE.move_to_end(cache_key)
    while len(_CACHE) > _CACHE_MAX_ENTRIES:
        _CACHE.popitem(last=False)
    return AudioChunk(data=pcm, transcript=text)
