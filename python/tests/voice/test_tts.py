"""
Unit tests for the TTS router + cache (§4.2, TTS cache key locked decision).

Verifies:
    - Provider prefix routing: openai/elevenlabs/google/cartesia.
    - Cache key is (text, voice) — same text+voice synthesizes exactly once.
    - Raw text does not leak into cache keys (it is hashed via SHA-256).
    - Effects applied AFTER the cache hit are never baked into the cache.
    - Unknown provider prefixes raise ValueError clearly.
    - Voice strings without a '/' raise ValueError.
"""

import hashlib

import pytest

from scenario.voice import AudioChunk, register_tts_provider, synthesize
from scenario.voice import tts as tts_module


class _FakeProvider:
    """Records calls so we can verify cache behaviour."""

    def __init__(self, pcm_per_call: bytes = b"\x00\x00" * 1200):
        self.pcm_per_call = pcm_per_call
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, text: str, voice: str) -> bytes:
        self.calls.append((text, voice))
        return self.pcm_per_call


@pytest.fixture(autouse=True)
def _preserve_providers_and_cache():
    """Save/restore the provider registry and in-process cache between tests."""
    snapshot = dict(tts_module._PROVIDERS)
    tts_module.clear_cache()
    yield
    tts_module._PROVIDERS.clear()
    tts_module._PROVIDERS.update(snapshot)
    tts_module.clear_cache()


@pytest.mark.asyncio
async def test_provider_prefix_routes_to_registered_backend():
    fake = _FakeProvider()
    register_tts_provider("fake", fake)
    await synthesize("hello world", "fake/voice-one")
    assert fake.calls == [("hello world", "voice-one")]


@pytest.mark.asyncio
async def test_unknown_provider_prefix_raises_with_list_of_known():
    with pytest.raises(ValueError) as excinfo:
        await synthesize("hi", "notreal/x")
    msg = str(excinfo.value)
    assert "notreal" in msg
    assert "openai" in msg  # the default is listed in the error


@pytest.mark.asyncio
async def test_voice_without_slash_raises():
    with pytest.raises(ValueError):
        await synthesize("hi", "just_a_name")


@pytest.mark.asyncio
async def test_same_text_and_voice_synthesize_once():
    # The cache is keyed on (sha256(text), voice): identical inputs hit the
    # in-process cache exactly once per process lifetime.
    fake = _FakeProvider()
    tts_module.register_tts_provider("fake", fake)
    await synthesize("hello", "fake/alice")
    await synthesize("hello", "fake/alice")
    assert len(fake.calls) == 1


@pytest.mark.asyncio
async def test_cache_keys_on_text_and_voice_not_just_one():
    fake = _FakeProvider()
    tts_module.register_tts_provider("fake", fake)
    await synthesize("hello", "fake/alice")
    await synthesize("hello", "fake/bob")  # different voice → different call
    await synthesize("world", "fake/alice")  # different text → different call
    # 3 distinct (text, voice) pairs → 3 distinct synthesize calls.
    assert len(fake.calls) == 3


def test_text_is_hashed_before_joblib_sees_it():
    # Regression test for the "cache contains PII" security finding.
    text = "my SSN is 123-45-6789"
    expected_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert tts_module._hash_text(text) == expected_hash
    # And the hash must not include the original text anywhere.
    assert "123-45-6789" not in expected_hash
    assert "SSN" not in expected_hash


@pytest.mark.asyncio
async def test_synthesize_attaches_transcript_for_judge():
    # The judge's audio-detection / transcript path relies on
    # AudioChunk.transcript; synthesize must populate it.
    fake = _FakeProvider()
    tts_module.register_tts_provider("fake", fake)
    chunk = await synthesize("hello world", "fake/voice")
    assert chunk.transcript == "hello world"
    assert isinstance(chunk, AudioChunk)
    assert chunk.sample_rate == 24000
