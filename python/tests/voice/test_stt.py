"""Unit tests for the pluggable STTProvider interface."""

import inspect
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import scenario
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


# ---------------------------------------------------------------- the public seam


def test_set_stt_provider_is_exported_from_the_package_root():
    """``scenario.set_stt_provider`` is the documented way to swap STT."""
    assert scenario.set_stt_provider is set_stt_provider
    assert "set_stt_provider" in scenario.__all__


def test_configure_does_not_accept_an_stt_argument():
    """
    ``configure()`` carries global execution settings only (ADR-002, ADR-003).

    Provider injection through it is the API bug in #743: the docstrings
    advertised it, the parameter never existed. Keeping the rejection asserted
    stops it being reintroduced as a process-wide provider knob instead of the
    per-run carrier ADR-002 specifies.
    """
    with pytest.raises(TypeError) as excinfo:
        scenario.configure(stt=FakeSTT())  # type: ignore[call-arg]  # The runtime rejection is the contract under test.
    assert "stt" in str(excinfo.value)


def test_no_shipped_source_advertises_configure_stt():
    """
    Nothing users read may claim ``configure(stt=...)`` installs a provider.

    A docstring, log line or example that says so sends the reader straight
    into a ``TypeError``. Walking the whole shipped package and the examples,
    rather than checking a fixed list of files, keeps a new one from slipping
    the claim back in.
    """
    python_root = Path(__file__).resolve().parents[2]
    roots = [Path(scenario.__file__).resolve().parent, python_root / "examples"]

    offenders = [
        str(path.relative_to(python_root))
        for root in roots
        for path in sorted(root.rglob("*.py"))
        if "configure(stt=" in path.read_text(encoding="utf-8")
    ]
    assert offenders == [], (
        "these files advertise the non-existent configure(stt=...) argument; "
        f"point them at scenario.set_stt_provider(...) instead: {offenders}"
    )


def test_set_stt_provider_rejects_a_non_provider():
    """A bad provider fails at the user's call, not inside a transcription pass."""
    previous = get_stt_provider()
    with pytest.raises(TypeError) as excinfo:
        set_stt_provider(object())  # type: ignore[arg-type]  # Passing an invalid provider is the contract under test.
    assert "STTProvider" in str(excinfo.value)
    assert get_stt_provider() is previous


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
