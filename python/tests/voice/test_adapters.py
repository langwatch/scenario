"""
Unit tests for platform adapters (Phase 2).

@unit scope: each adapter is constructable, advertises a capabilities matrix,
implements connect/disconnect cleanly. Deep transport behaviour is exercised
at @integration scope (requires real platform creds).
"""

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
    a = OpenAIRealtimeAgentAdapter(model="gpt-realtime-mini", voice="alloy")
    assert a.role == scenario.AgentRole.AGENT


def test_openai_realtime_default_model_is_current_ga():
    """Default model must come from voice_models.OPENAI_REALTIME_MODEL."""
    from scenario.config.voice_models import OPENAI_REALTIME_MODEL
    a = OpenAIRealtimeAgentAdapter()
    assert a.model == OPENAI_REALTIME_MODEL


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
    from scenario.config.voice_models import GEMINI_LIVE_MODEL
    assert a.model == GEMINI_LIVE_MODEL
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
        # connect() sends conversation_initiation_client_data first, then
        # send_audio emits TWO chunks per call (speech + silence tail —
        # see ElevenLabsAgentAdapter.send_audio for the empirical
        # rationale). Walk all sent messages and assert the speech chunk
        # is among them.
        chunk = AudioChunk(data=b"\x10\x20" * 100)
        await adapter.send_audio(chunk)
        user_audio_decoded = []
        for call in mock_ws.send.call_args_list:
            payload = json.loads(call[0][0])
            if "user_audio_chunk" in payload:
                user_audio_decoded.append(base64.b64decode(payload["user_audio_chunk"]))
        assert chunk.data in user_audio_decoded

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

    # connect() now sends `conversation_initiation_client_data` first
    # (empirically required for EL to reliably trigger `first_message`).
    # The pong is therefore the SECOND send.
    init_send = json.loads(mock_ws.send.call_args_list[0][0][0])
    assert init_send["type"] == "conversation_initiation_client_data"
    pong_send = json.loads(mock_ws.send.call_args_list[1][0][0])
    assert pong_send["type"] == "pong"
    assert pong_send["event_id"] == 42


@pytest.mark.asyncio
async def test_elevenlabs_hosted_adapter_replies_to_ping_nested_shape():
    """The real EL ConvAI wire shape nests event_id under ``ping_event``.
    The adapter must extract the id from there to keep EL's pong validator
    (PongClientToOrchestratorEvent.event_id requires a valid integer) happy.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")

    pcm_payload = b"\x00\x00" * 8
    b64_audio = base64.b64encode(pcm_payload).decode()
    events = [
        json.dumps({"type": "ping", "ping_event": {"event_id": 7, "ping_ms": 12}}),
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

    # As with the flat-shape test: init goes first, pong is second.
    init_send = json.loads(mock_ws.send.call_args_list[0][0][0])
    assert init_send["type"] == "conversation_initiation_client_data"
    pong_send = json.loads(mock_ws.send.call_args_list[1][0][0])
    assert pong_send["type"] == "pong"
    assert pong_send["event_id"] == 7


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

    # Stub synthesize (TTS) — real synthesize returns AudioChunk, not bytes.
    synthesized_pcm = b"\x00\x00" * 24000  # 1 second of silence
    assert len(synthesized_pcm) % 2 == 0
    synthesized_chunk = AudioChunk(data=synthesized_pcm, transcript="hi there")

    agent = ComposableVoiceAgent(stt=fake_stt, llm="openai/gpt-4o-mini", tts="openai/nova")
    await agent.connect()

    chunk_in = AudioChunk(data=b"\x00\x00" * 100)

    with patch("litellm.acompletion", new=AsyncMock(return_value=fake_completion)) as mock_llm, \
         patch("scenario.voice.tts.synthesize", new=AsyncMock(return_value=synthesized_chunk)) as mock_tts:
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
    from scenario.config.voice_models import COMPOSABLE_VOICE_LLM_MODEL
    agent = ElevenLabsVoiceAgent(api_key="test_key")
    assert agent.llm == COMPOSABLE_VOICE_LLM_MODEL
    assert "elevenlabs/" in agent.voice
    assert isinstance(agent.stt, ElevenLabsSTTProvider)


def test_branded_elevenlabs_voice_agent_override():
    """Override each piece individually; other defaults must be retained."""
    from scenario.config.voice_models import COMPOSABLE_VOICE_LLM_MODEL
    class _MyStt(STTProvider):
        async def transcribe(self, audio: AudioChunk) -> str:
            return ""

    custom_stt = _MyStt()

    # Override STT only.
    a1 = ElevenLabsVoiceAgent(api_key="k", stt=custom_stt)
    assert a1.stt is custom_stt
    assert a1.llm == COMPOSABLE_VOICE_LLM_MODEL
    assert "elevenlabs/" in a1.voice

    # Override LLM only.
    a2 = ElevenLabsVoiceAgent(api_key="k", llm="openai/gpt-4o")
    assert a2.llm == "openai/gpt-4o"
    assert isinstance(a2.stt, ElevenLabsSTTProvider)
    assert "elevenlabs/" in a2.voice

    # Override TTS voice only.
    a3 = ElevenLabsVoiceAgent(api_key="k", voice="elevenlabs/bella")
    assert a3.voice == "elevenlabs/bella"
    assert a3.llm == COMPOSABLE_VOICE_LLM_MODEL
    assert isinstance(a3.stt, ElevenLabsSTTProvider)


def test_branded_elevenlabs_voice_agent_repr_redacts_key():
    agent = ElevenLabsVoiceAgent(api_key="super_secret")
    assert "super_secret" not in repr(agent)
    assert "***" in repr(agent)


def test_branded_elevenlabs_voice_agent_is_voice_adapter():
    assert issubclass(ElevenLabsVoiceAgent, VoiceAgentAdapter)


# ---------------------------------------------------------------- OpenAIRealtime transport

@pytest.mark.asyncio
async def test_openai_realtime_adapter_connects_and_sends_pcm16():
    """Verify URL construction, session.update on connect, audio send/recv round-trip."""
    adapter = OpenAIRealtimeAgentAdapter(
        model="gpt-realtime-mini",
        voice="alloy",
        api_key="sk-test",
    )

    pcm_payload = b"\x00\x01" * 8  # 16 bytes of dummy PCM16
    b64_audio = base64.b64encode(pcm_payload).decode()

    events = [
        json.dumps({"type": "session.created", "session": {}}),
        json.dumps({"type": "session.updated", "session": {}}),
        json.dumps({"type": "response.audio.delta", "delta": b64_audio}),
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

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)) as mock_connect:
        await adapter.connect()

        # Verify the URL contains the model.
        connect_url = mock_connect.call_args[0][0]
        assert "model=gpt-realtime-mini" in connect_url
        assert "api.openai.com" in connect_url

        # Verify session.update was emitted (first send call).
        first_send_raw = mock_ws.send.call_args_list[0][0][0]
        first_sent = json.loads(first_send_raw)
        assert first_sent["type"] == "session.update"
        assert first_sent["session"]["input_audio_format"] == "pcm16"
        assert first_sent["session"]["output_audio_format"] == "pcm16"

        # send_audio must emit input_audio_buffer.append with base64 PCM16.
        chunk = AudioChunk(data=b"\x10\x20" * 100)
        await adapter.send_audio(chunk)
        send_calls = mock_ws.send.call_args_list
        audio_send = json.loads(send_calls[1][0][0])
        assert audio_send["type"] == "input_audio_buffer.append"
        decoded = base64.b64decode(audio_send["audio"])
        assert decoded == chunk.data

        # recv_audio must skip housekeeping events and return the audio delta.
        result = await adapter.recv_audio(timeout=5.0)
        assert isinstance(result, AudioChunk)
        assert result.data == pcm_payload

        await adapter.disconnect()


@pytest.mark.asyncio
async def test_openai_realtime_adapter_send_text_routes_user_role():
    """role=USER: send_text emits conversation.item.create + response.create."""
    adapter = OpenAIRealtimeAgentAdapter(
        role=scenario.AgentRole.USER,
        api_key="sk-test",
    )

    mock_ws = AsyncMock()
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        # Reset send calls so we only inspect send_text's output.
        mock_ws.send.reset_mock()

        await adapter.send_text("hello")

    assert mock_ws.send.call_count == 2

    item_create_raw = mock_ws.send.call_args_list[0][0][0]
    item_create = json.loads(item_create_raw)
    assert item_create["type"] == "conversation.item.create"
    item = item_create["item"]
    assert item["role"] == "user"
    assert item["content"][0]["type"] == "input_text"
    assert item["content"][0]["text"] == "hello"

    response_create_raw = mock_ws.send.call_args_list[1][0][0]
    response_create = json.loads(response_create_raw)
    assert response_create["type"] == "response.create"


@pytest.mark.asyncio
async def test_openai_realtime_adapter_tracks_transcripts():
    """Transcript delta events update last_agent_transcript / last_user_transcript."""
    adapter = OpenAIRealtimeAgentAdapter(api_key="sk-test")

    pcm_payload = b"\x00\x00" * 8
    b64_audio = base64.b64encode(pcm_payload).decode()

    events = [
        json.dumps({"type": "response.audio_transcript.delta", "delta": "Hello "}),
        json.dumps({"type": "response.audio_transcript.delta", "delta": "world"}),
        json.dumps({"type": "response.audio_transcript.done", "transcript": "Hello world"}),
        json.dumps({
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "user said hello",
        }),
        json.dumps({"type": "response.audio.delta", "delta": b64_audio}),
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

    assert adapter.last_agent_transcript == "Hello world"
    assert adapter.last_user_transcript == "user said hello"


@pytest.mark.asyncio
async def test_openai_realtime_adapter_raises_on_error_event():
    """Server error events must surface as RuntimeError with the message text."""
    adapter = OpenAIRealtimeAgentAdapter(api_key="sk-test")

    events = [
        json.dumps({"type": "error", "error": {"message": "oops, something went wrong"}}),
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
        with pytest.raises(RuntimeError, match="oops, something went wrong"):
            await adapter.recv_audio(timeout=5.0)


def test_openai_realtime_adapter_repr_redacts_api_key():
    """__repr__ must not expose the api_key value."""
    adapter = OpenAIRealtimeAgentAdapter(api_key="super_secret_key_xyz")
    r = repr(adapter)
    assert "super_secret_key_xyz" not in r
    assert "***" in r


# ---------------------------------------------------------------- GeminiLive transport

from contextlib import asynccontextmanager  # noqa: E402


def _make_gemini_session(messages):
    """Return an AsyncMock session whose receive() yields the given messages."""
    session = AsyncMock()

    async def _fake_receive():
        for msg in messages:
            yield msg

    session.receive = _fake_receive
    session.send_realtime_input = AsyncMock()
    return session


def _make_genai_client_patch(session):
    """Patch google.genai.Client so that client.aio.live.connect yields ``session``."""
    mock_client = MagicMock()
    mock_aio = MagicMock()
    mock_live = MagicMock()

    @asynccontextmanager
    async def _fake_connect(**kwargs):
        yield session

    mock_live.connect = _fake_connect
    mock_aio.live = mock_live
    mock_client.aio = mock_aio

    return mock_client


def _audio_message(pcm_bytes: bytes):
    """Build a LiveServerMessage with an audio inline_data part."""
    from google.genai import types
    part = types.Part(inline_data=types.Blob(data=pcm_bytes, mime_type="audio/pcm;rate=24000"))
    content = types.Content(parts=[part])
    sc = types.LiveServerContent(model_turn=content, turn_complete=True)
    return types.LiveServerMessage(server_content=sc)


def _transcript_message(text: str):
    """Build a LiveServerMessage with an output_transcription only."""
    from google.genai import types
    sc = types.LiveServerContent(
        output_transcription=types.Transcription(text=text, finished=True),
    )
    return types.LiveServerMessage(server_content=sc)


@pytest.mark.asyncio
async def test_gemini_live_adapter_connects_with_model_and_api_key():
    """Client is constructed with the supplied api_key; connect uses the correct model."""
    session = _make_gemini_session([])
    mock_client = _make_genai_client_patch(session)

    captured: dict = {}

    @asynccontextmanager
    async def _recording_connect(*, model, config):
        captured["model"] = model
        captured["config"] = config
        yield session

    mock_client.aio.live.connect = _recording_connect

    with patch("google.genai.Client", return_value=mock_client) as mock_cls:
        adapter = GeminiLiveAgentAdapter(
            model="gemini-2.5-flash-native-audio",
            system_instruction="You are helpful.",
            api_key="gm-test-key",
        )
        await adapter.connect()
        await adapter.disconnect()

    # Client was constructed with the api_key.
    mock_cls.assert_called_once_with(api_key="gm-test-key")
    # connect() received the right model.
    assert captured["model"] == "gemini-2.5-flash-native-audio"
    # system_instruction flowed through to the config.
    assert captured["config"].system_instruction == "You are helpful."


@pytest.mark.asyncio
async def test_gemini_live_adapter_sends_resampled_audio():
    """24kHz canonical AudioChunk is wrapped in activity_start/audio/activity_end
    (AAD-off path), with the audio resampled 24kHz → 16kHz at the wire."""
    import numpy as np

    session = _make_gemini_session([])
    mock_client = _make_genai_client_patch(session)

    with patch("google.genai.Client", return_value=mock_client):
        adapter = GeminiLiveAgentAdapter(api_key="k")
        await adapter.connect()

        # 24kHz PCM16 input — 480 samples = 20ms
        n_samples_24k = 480
        pcm_24k = (np.zeros(n_samples_24k, dtype="<i2")).tobytes()
        chunk = AudioChunk(data=pcm_24k)
        await adapter.send_audio(chunk)

        await adapter.disconnect()

    # send_realtime_input is called three times per send_audio:
    # activity_start, audio, activity_end.
    assert session.send_realtime_input.call_count == 3
    calls = session.send_realtime_input.call_args_list

    # 1) activity_start
    assert "activity_start" in calls[0].kwargs
    # 2) audio blob — resampled to 16kHz
    assert "audio" in calls[1].kwargs
    blob = calls[1].kwargs["audio"]
    assert "16000" in blob.mime_type
    resampled_samples = len(blob.data) // 2
    expected_samples = int(n_samples_24k * 16000 / 24000)
    assert abs(resampled_samples - expected_samples) <= 1  # ±1 rounding
    # 3) activity_end
    assert "activity_end" in calls[2].kwargs


@pytest.mark.asyncio
async def test_gemini_live_adapter_returns_agent_audio():
    """recv_audio returns an AudioChunk with the bytes from the server's audio part."""
    pcm_bytes = b"\x10\x20" * 100  # 200 bytes of PCM16 — must be even

    audio_msg = _audio_message(pcm_bytes)
    session = _make_gemini_session([audio_msg])
    mock_client = _make_genai_client_patch(session)

    with patch("google.genai.Client", return_value=mock_client):
        adapter = GeminiLiveAgentAdapter(api_key="k")
        await adapter.connect()
        result = await adapter.recv_audio(timeout=5.0)
        await adapter.disconnect()

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_bytes


@pytest.mark.asyncio
async def test_gemini_live_adapter_tracks_transcripts():
    """output_transcription text populates last_agent_transcript."""
    transcript_msg = _transcript_message("Hello from Gemini")
    # Follow with an audio message so recv_audio returns.
    audio_msg = _audio_message(b"\x00\x00" * 8)
    session = _make_gemini_session([transcript_msg, audio_msg])
    mock_client = _make_genai_client_patch(session)

    with patch("google.genai.Client", return_value=mock_client):
        adapter = GeminiLiveAgentAdapter(api_key="k")
        await adapter.connect()
        await adapter.recv_audio(timeout=5.0)
        await adapter.disconnect()

    assert adapter.last_agent_transcript == "Hello from Gemini"


@pytest.mark.asyncio
async def test_gemini_live_adapter_raises_on_error_event():
    """go_away messages must surface as RuntimeError."""
    from google.genai import types

    error_msg = types.LiveServerMessage(
        go_away=types.LiveServerGoAway(time_left=None),  # type: ignore[arg-type]
    )
    session = _make_gemini_session([error_msg])
    mock_client = _make_genai_client_patch(session)

    with patch("google.genai.Client", return_value=mock_client):
        adapter = GeminiLiveAgentAdapter(api_key="k")
        await adapter.connect()
        with pytest.raises(RuntimeError, match="go_away"):
            await adapter.recv_audio(timeout=5.0)
        await adapter.disconnect()


def test_gemini_live_adapter_repr_redacts_api_key():
    """__repr__ must not expose the api_key value."""
    adapter = GeminiLiveAgentAdapter(api_key="gemini-secret-key-xyz")
    r = repr(adapter)
    assert "gemini-secret-key-xyz" not in r
    assert "***" in r
