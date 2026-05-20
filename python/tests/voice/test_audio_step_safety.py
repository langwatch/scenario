"""
Unit tests for scenario.audio() path/URL safety (security review finding #3).
"""

import pytest

import scenario
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter


class _SpyAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities()

    def __init__(self):
        super().__init__()
        self.sent: list[AudioChunk] = []

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def send_audio(self, chunk):
        self.sent.append(chunk)

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


class _FakeState:
    def __init__(self, adapter):
        self.messages = []
        self._executor = type("E", (), {"agents": [adapter]})()


@pytest.mark.asyncio
async def test_audio_rejects_http_url():
    # http:// strings must never reach ffmpeg's -i argument (ffmpeg would
    # issue an outbound HTTP request on the user's behalf).
    step = scenario.audio("http://evil.example/payload.mp3")
    with pytest.raises(ValueError) as excinfo:
        await step(_FakeState(_SpyAdapter()))  # type: ignore[arg-type,misc,index]
    assert "http://evil.example/payload.mp3" in str(excinfo.value)
    assert "URL-like" in str(excinfo.value) or "download the asset" in str(excinfo.value)


@pytest.mark.asyncio
async def test_audio_rejects_rtmp_url():
    step = scenario.audio("rtmp://evil.example/stream")
    with pytest.raises(ValueError):
        await step(_FakeState(_SpyAdapter()))  # type: ignore[arg-type,misc,index]


@pytest.mark.asyncio
async def test_audio_rejects_missing_file():
    step = scenario.audio("/nonexistent/path/that/does/not/exist.wav")
    with pytest.raises(FileNotFoundError):
        await step(_FakeState(_SpyAdapter()))  # type: ignore[arg-type,misc,index]


@pytest.mark.asyncio
async def test_audio_from_bytes_is_fine():
    # Build a short valid WAV in memory; bytes path doesn't go through
    # path validation, so this must still work.
    import wave, io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 2400)
    wav_bytes = buf.getvalue()

    adapter = _SpyAdapter()
    await scenario.audio(wav_bytes)(_FakeState(adapter))  # type: ignore[arg-type,misc,index]
    assert len(adapter.sent) == 1
