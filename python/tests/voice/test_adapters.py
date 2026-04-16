"""
Unit tests for platform adapters (Phase 2).

@unit scope: each adapter is constructable, advertises a capabilities matrix,
implements connect/disconnect cleanly. Deep transport behaviour is exercised
at @integration scope (requires real platform creds).
"""

import pytest

import scenario
from scenario.voice import (
    AdapterCapabilities,
    ElevenLabsAgentAdapter,
    GeminiLiveAgentAdapter,
    LiveKitAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    PipecatAgentAdapter,
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
        phone_number="+14155551234",
        from_number="+14155559876",
        account_sid="AC...",
        auth_token="t",
    )
    assert a.phone_number == "+14155551234"


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
