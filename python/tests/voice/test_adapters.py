"""
Unit tests for platform adapters (Phase 2).

@unit scope: each adapter is constructable, advertises a capabilities matrix,
implements connect/disconnect cleanly. Deep transport behaviour is exercised
at @integration scope (requires real platform creds).
"""

import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import scenario
from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    ComposableVoiceAgent,
    ElevenLabsAgentAdapter,
    ElevenLabsSTTProvider,
    ElevenLabsVoiceAgent,
    GeminiLiveAgentAdapter,
    LiveKitAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    PipecatAgentAdapter,
    STTProvider,
    TwilioAgentAdapter,
    VapiAgentAdapter,
    VoiceAgentAdapter,
    WebRTCAgentAdapter,
    WebSocketAgentAdapter,
    WebSocketProtocol,
)


# ---------------------------------------------------------------- PipecatAgentAdapter

def test_pipecat_websocket_construction_sets_transport_format():
    a = PipecatAgentAdapter(url="ws://localhost:8765/ws", audio_format="mulaw", sample_rate=8000)
    assert a.transport == "websocket"
    assert a.url == "ws://localhost:8765/ws"
    assert a.transport_format == "mulaw/8000"


def test_pipecat_webrtc_requires_signaling_url():
    a = PipecatAgentAdapter(signaling_url="http://localhost:7860/api/offer", transport="webrtc")
    assert a.transport == "webrtc"
    assert a.signaling_url == "http://localhost:7860/api/offer"


def test_pipecat_websocket_rejects_missing_url():
    with pytest.raises(ValueError):
        PipecatAgentAdapter(transport="websocket")


def test_pipecat_capabilities_advertise_streaming_and_vad():
    caps = PipecatAgentAdapter.capabilities
    assert caps.streaming_transcripts is True
    assert caps.native_vad is True
    assert caps.dtmf is False


# ---------------------------------------------------------------- LiveKitAgentAdapter

def test_livekit_construction():
    a = LiveKitAgentAdapter(
        url="wss://my-app.livekit.cloud",
        api_key="k",
        api_secret="s",
        room="test-room-123",
    )
    assert a.room == "test-room-123"
    assert LiveKitAgentAdapter.capabilities.native_vad is True


# ---------------------------------------------------------------- TwilioAgentAdapter

def test_twilio_advertises_dtmf_capability():
    caps = TwilioAgentAdapter.capabilities
    assert caps.dtmf is True
    # Media Streams has no native STT — after_words must raise on this adapter.
    assert caps.streaming_transcripts is False
    # And no native VAD — SDK falls back to webrtcvad.
    assert caps.native_vad is False


def test_twilio_construction():
    a = TwilioAgentAdapter(
        account_sid="AC...",
        auth_token="t",
        phone_number="+14155551234",
    )
    assert a.phone_number == "+14155551234"


def test_twilio_rejects_non_e164_phone_number():
    import pytest as _pytest

    with _pytest.raises(ValueError, match="E.164"):
        TwilioAgentAdapter(
            account_sid="AC...",
            auth_token="t",
            phone_number="4155551234",  # missing +
        )


# ---------------------------------------------------------------- ElevenLabs

def test_elevenlabs_url_includes_agent_id():
    a = ElevenLabsAgentAdapter(agent_id="abc123", api_key="k")
    assert a.url == "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=abc123"


# ---------------------------------------------------------------- Vapi

def test_vapi_capabilities():
    a = VapiAgentAdapter(assistant_id="asst_...", api_key="k")
    assert a.assistant_id == "asst_..."
    assert VapiAgentAdapter.capabilities.streaming_transcripts is True


# ---------------------------------------------------------------- OpenAIRealtime

def test_openai_realtime_defaults_to_agent_role():
    a = OpenAIRealtimeAgentAdapter(model="gpt-4o-realtime-preview", voice="alloy")
    assert a.role == scenario.AgentRole.AGENT


def test_openai_realtime_user_role_is_a_chosen_alternative():
    # Source §7.2 L1164-1171: this is a CHOSEN alternative, not a rejection.
    a = OpenAIRealtimeAgentAdapter(role=scenario.AgentRole.USER)
    assert a.role == scenario.AgentRole.USER


def test_openai_realtime_capabilities_are_streaming():
    caps = OpenAIRealtimeAgentAdapter.capabilities
    assert caps.streaming_transcripts is True
    assert caps.native_vad is True


# ---------------------------------------------------------------- GeminiLive

def test_gemini_live_defaults():
    a = GeminiLiveAgentAdapter()
    assert a.model == "gemini-2.5-flash-native-audio"
    assert a.voice == "Algieba"


# ---------------------------------------------------------------- WebSocketAgentAdapter

class _EchoProtocol(WebSocketProtocol):
    def encode_audio(self, audio):
        return audio

    def decode_response(self, message):
        from scenario.voice import AudioChunk

        return AudioChunk(data=message) if isinstance(message, (bytes, bytearray)) else None  # type: ignore[arg-type,misc,index]


def test_websocket_agent_stores_protocol():
    a = WebSocketAgentAdapter(url="wss://example.com/ws", protocol=_EchoProtocol())
    assert a.url == "wss://example.com/ws"
    assert isinstance(a.protocol, _EchoProtocol)


def test_websocket_protocol_is_abstract():
    with pytest.raises(TypeError):
        WebSocketProtocol()  # type: ignore[abstract]


# ---------------------------------------------------------------- WebRTCAgentAdapter

def test_webrtc_agent_stores_signaling_url():
    a = WebRTCAgentAdapter(signaling_url="https://example.com/offer")
    assert a.signaling_url == "https://example.com/offer"


# ---------------------------------------------------------------- all adapters

ALL_ADAPTER_CLASSES = [
    PipecatAgentAdapter,
    LiveKitAgentAdapter,
    TwilioAgentAdapter,
    ElevenLabsAgentAdapter,
    VapiAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    GeminiLiveAgentAdapter,
    WebRTCAgentAdapter,
]


@pytest.mark.parametrize("cls", ALL_ADAPTER_CLASSES)
def test_every_adapter_publishes_capabilities(cls):
    caps = cls.capabilities
    assert isinstance(caps, AdapterCapabilities)
    # Every adapter must declare its formats.
    assert isinstance(caps.input_formats, list)
    assert isinstance(caps.output_formats, list)


@pytest.mark.parametrize("cls", ALL_ADAPTER_CLASSES)
def test_every_adapter_subclasses_voice_agent_adapter(cls):
    assert issubclass(cls, VoiceAgentAdapter)


# ---------------------------------------------------------------- ElevenLabs hosted transport

@pytest.mark.asyncio
async def test_elevenlabs_hosted_adapter_connects_and_sends_pcm16():
    """Scenario §5.4: hosted WebSocket transport — URL, send, recv round-trip."""
    adapter = ElevenLabsAgentAdapter(agent_id="test_agent", api_key="test_key")

    # Build a fake WebSocket that records what was sent and serves canned events.
    pcm_payload = b"\x00\x01" * 8  # 16 bytes of dummy PCM16
    b64_audio = base64.b64encode(pcm_payload).decode()

    events = [
        json.dumps({"type": "conversation_initiation_metadata", "metadata": {}}),
        json.dumps({"type": "user_transcript", "user_transcription_event": {"user_transcript": "hello"}}),
        json.dumps({"type": "audio", "audio_event": {"audio_base_64": b64_audio}}),
    ]
    call_index = 0

    mock_ws = AsyncMock()

    async def fake_recv():
        nonlocal call_index
        msg = events[call_index]
        call_index += 1
        return msg

    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    # Patch websockets.connect to return our mock.
    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)) as mock_connect:
        await adapter.connect()

        # Verify URL contains agent_id.
        connect_url = mock_connect.call_args[0][0]
        assert "agent_id=test_agent" in connect_url
        assert "api.elevenlabs.io" in connect_url

        # send_audio should emit a base64-encoded user_audio_chunk message.
        chunk = AudioChunk(data=b"\x10\x20" * 100)
        await adapter.send_audio(chunk)
        sent_raw = mock_ws.send.call_args[0][0]
        sent = json.loads(sent_raw)
        assert "user_audio_chunk" in sent
        decoded = base64.b64decode(sent["user_audio_chunk"])
        assert decoded == chunk.data

        # recv_audio must skip metadata + transcript and return audio bytes.
        result = await adapter.recv_audio(timeout=5.0)
        assert isinstance(result, AudioChunk)
        assert result.data == pcm_payload

        await adapter.disconnect()


@pytest.mark.asyncio
async def test_elevenlabs_hosted_adapter_replies_to_ping():
    """Ping events must be replied to with a pong (event_id forwarded)."""
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")

    pcm_payload = b"\x00\x00" * 8
    b64_audio = base64.b64encode(pcm_payload).decode()
    events = [
        json.dumps({"type": "ping", "event_id": 42}),
        json.dumps({"type": "audio", "audio_event": {"audio_base_64": b64_audio}}),
    ]
    call_index = 0

    mock_ws = AsyncMock()

    async def fake_recv():
        nonlocal call_index
        msg = events[call_index]
        call_index += 1
        return msg

    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        await adapter.recv_audio(timeout=5.0)

    # First send call should be the pong.
    first_send = json.loads(mock_ws.send.call_args_list[0][0][0])
    assert first_send["type"] == "pong"
    assert first_send["event_id"] == 42


# ---------------------------------------------------------------- ComposableVoiceAgent

class _FakeSTT(STTProvider):
    """Records calls; returns canned transcript."""

    def __init__(self, canned: str = "user said hello") -> None:
        self.canned = canned
        self.calls: list[AudioChunk] = []

    async def transcribe(self, audio: AudioChunk) -> str:
        self.calls.append(audio)
        return self.canned


@pytest.mark.asyncio
async def test_composable_voice_agent_mix_and_match():
    """Each seam (STT, LLM, TTS) is called exactly once per turn."""
    fake_stt = _FakeSTT(canned="hello")

    # Stub litellm.acompletion.
    fake_choice = MagicMock()
    fake_choice.message.content = "hi there"
    fake_completion = MagicMock()
    fake_completion.choices = [fake_choice]

    # Stub synthesize (TTS).
    synthesized_pcm = b"\x00\x00" * 24000  # 1 second of silence
    assert len(synthesized_pcm) % 2 == 0

    agent = ComposableVoiceAgent(stt=fake_stt, llm="openai/gpt-4o-mini", tts="openai/nova")
    await agent.connect()

    chunk_in = AudioChunk(data=b"\x00\x00" * 100)

    with patch("litellm.acompletion", new=AsyncMock(return_value=fake_completion)) as mock_llm, \
         patch("scenario.voice.tts.synthesize", new=AsyncMock(return_value=synthesized_pcm)) as mock_tts:
        await agent.send_audio(chunk_in)
        result = await agent.recv_audio(timeout=10.0)

    # STT seam called once.
    assert len(fake_stt.calls) == 1
    assert fake_stt.calls[0] is chunk_in

    # LLM seam called once; last message in history is the user transcript.
    mock_llm.assert_called_once()
    assert agent.last_user_transcript == "hello"
    assert agent.last_llm_response == "hi there"

    # TTS seam called once.
    mock_tts.assert_called_once_with("hi there", "openai/nova")

    # Result is a valid AudioChunk.
    assert isinstance(result, AudioChunk)
    assert result.data == synthesized_pcm

    await agent.disconnect()


def test_composable_voice_agent_implements_adapter_contract():
    """ComposableVoiceAgent is a VoiceAgentAdapter."""
    assert issubclass(ComposableVoiceAgent, VoiceAgentAdapter)
    caps = ComposableVoiceAgent.capabilities
    assert isinstance(caps, AdapterCapabilities)
    assert caps.input_formats == ["pcm16/24000"]
    assert caps.output_formats == ["pcm16/24000"]


# ---------------------------------------------------------------- ElevenLabsVoiceAgent (branded)

def test_branded_elevenlabs_voice_agent_defaults():
    """Instantiate with only api_key; defaults must match spec."""
    agent = ElevenLabsVoiceAgent(api_key="test_key")
    assert agent.llm == "openai/gpt-4o-mini"
    assert "elevenlabs/" in agent.voice
    assert isinstance(agent.stt, ElevenLabsSTTProvider)


def test_branded_elevenlabs_voice_agent_override():
    """Override each piece individually; other defaults must be retained."""
    class _MyStt(STTProvider):
        async def transcribe(self, audio: AudioChunk) -> str:
            return ""

    custom_stt = _MyStt()

    # Override STT only.
    a1 = ElevenLabsVoiceAgent(api_key="k", stt=custom_stt)
    assert a1.stt is custom_stt
    assert a1.llm == "openai/gpt-4o-mini"
    assert "elevenlabs/" in a1.voice

    # Override LLM only.
    a2 = ElevenLabsVoiceAgent(api_key="k", llm="openai/gpt-4o")
    assert a2.llm == "openai/gpt-4o"
    assert isinstance(a2.stt, ElevenLabsSTTProvider)
    assert "elevenlabs/" in a2.voice

    # Override TTS voice only.
    a3 = ElevenLabsVoiceAgent(api_key="k", voice="elevenlabs/bella")
    assert a3.voice == "elevenlabs/bella"
    assert a3.llm == "openai/gpt-4o-mini"
    assert isinstance(a3.stt, ElevenLabsSTTProvider)


def test_branded_elevenlabs_voice_agent_repr_redacts_key():
    agent = ElevenLabsVoiceAgent(api_key="super_secret")
    assert "super_secret" not in repr(agent)
    assert "***" in repr(agent)


def test_branded_elevenlabs_voice_agent_is_voice_adapter():
    assert issubclass(ElevenLabsVoiceAgent, VoiceAgentAdapter)
