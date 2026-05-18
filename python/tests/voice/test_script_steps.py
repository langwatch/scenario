"""Unit tests for voice script steps (sleep, silence, audio, dtmf)."""

import time

import pytest

import scenario
from scenario.voice import AdapterCapabilities, AudioChunk, UnsupportedCapabilityError, VoiceAgentAdapter


class _SpyAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(dtmf=False)

    def __init__(self):
        super().__init__()
        self.sent: list[AudioChunk] = []

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk): self.sent.append(chunk)
    async def recv_audio(self, timeout): return AudioChunk(data=b"")


class _TelephonyAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(dtmf=True)

    def __init__(self):
        super().__init__()
        self.dtmf_calls: list[str] = []
        self.sent: list[AudioChunk] = []

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk): self.sent.append(chunk)
    async def recv_audio(self, timeout): return AudioChunk(data=b"")
    async def send_dtmf(self, tones: str): self.dtmf_calls.append(tones)


class _FakeState:
    """Minimal ScenarioState stand-in for unit-testing script steps."""

    def __init__(self, agents, messages=None):
        self.agents = agents
        self.messages = messages if messages is not None else []
        self._executor = type("E", (), {"agents": agents})()


@pytest.mark.asyncio
async def test_sleep_does_not_send_audio_and_pauses_real_time():
    # Two-sided assertion: catches both "sleep got skipped" (the lower bound)
    # AND "sleep got stuck or balloons wall-clock" (the upper bound). A
    # one-sided lower bound would silently pass even if asyncio.sleep ever
    # gets stubbed to a no-op in this code path. 50ms target with 40ms floor
    # / 1s ceiling keeps the suite tight without flaking on CI scheduler
    # jitter.
    target = 0.05
    adapter = _SpyAdapter()
    state = _FakeState([adapter])
    step = scenario.sleep(target)
    t0 = time.monotonic()
    await step(state)  # type: ignore[arg-type,misc]
    elapsed = time.monotonic() - t0
    assert 0.8 * target <= elapsed <= 1.0
    assert adapter.sent == []  # no audio transmitted


@pytest.mark.asyncio
async def test_silence_sends_pcm16_zero_audio_of_requested_duration():
    adapter = _SpyAdapter()
    state = _FakeState([adapter])
    await scenario.silence(0.1)(state)  # type: ignore[arg-type,misc]
    assert len(adapter.sent) == 1
    chunk = adapter.sent[0]
    assert abs(chunk.duration_seconds - 0.1) < 1e-3
    assert set(chunk.data) == {0}


@pytest.mark.asyncio
async def test_audio_bytes_injects_chunk_into_adapter():
    # Use raw PCM bytes so we don't need ffmpeg to transcode in a unit test.
    # The step uses ffmpeg, which is bundled via imageio-ffmpeg.
    # Build a valid WAV header so ffmpeg can decode it.
    import wave, io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 2400)
    wav_bytes = buf.getvalue()

    adapter = _SpyAdapter()
    state = _FakeState([adapter])
    await scenario.audio(wav_bytes)(state)  # type: ignore[arg-type,misc]
    assert len(adapter.sent) == 1
    # Decoded back to PCM16 24kHz mono → should match what we put in.
    assert adapter.sent[0].sample_rate == 24000


@pytest.mark.asyncio
async def test_dtmf_on_non_telephony_raises_unsupported_capability_error():
    adapter = _SpyAdapter()
    state = _FakeState([adapter])
    with pytest.raises(UnsupportedCapabilityError) as excinfo:
        await scenario.dtmf("1")(state)  # type: ignore[arg-type,misc]
    assert "dtmf" in str(excinfo.value).lower()


@pytest.mark.asyncio
async def test_dtmf_on_telephony_adapter_delegates_to_send_dtmf():
    adapter = _TelephonyAdapter()
    state = _FakeState([adapter])
    await scenario.dtmf("123")(state)  # type: ignore[arg-type,misc]
    assert adapter.dtmf_calls == ["123"]
