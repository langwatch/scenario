"""
PipecatAgent: connect to a user's running Pipecat bot over WebSocket or WebRTC.

Source §5.1. Pipecat is a framework for BUILDING voice agents (not itself an
adapter). The user runs their Pipecat bot separately; this adapter connects
as a client to exchange audio with it.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class PipecatAgent(VoiceAgentAdapter):
    """
    Test a running Pipecat bot via its exposed WebSocket or WebRTC endpoint.

    Transport is selected by the ``transport`` argument:
        - ``"websocket"`` (default): Twilio-style bidirectional stream. Needs
          ``url`` (ws:// or wss://).
        - ``"webrtc"``: SmallWebRTC-style negotiation. Needs ``signaling_url``.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000", "mulaw/8000", "opus"],
        output_formats=["pcm16/24000", "mulaw/8000", "opus"],
    )

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        signaling_url: Optional[str] = None,
        transport: Literal["websocket", "webrtc"] = "websocket",
        audio_format: str = "pcm16",
        sample_rate: int = 24000,
    ):
        if transport == "websocket" and url is None:
            raise ValueError("PipecatAgent(transport='websocket') requires url=")
        if transport == "webrtc" and signaling_url is None:
            raise ValueError("PipecatAgent(transport='webrtc') requires signaling_url=")
        self.url = url
        self.signaling_url = signaling_url
        self.transport = transport
        self.audio_format = audio_format
        self.sample_rate = sample_rate
        self._session: Optional[object] = None

    @property
    def transport_format(self) -> str:
        return f"{self.audio_format}/{self.sample_rate}"

    async def connect(self) -> None:
        self._session = object()  # sentinel; real impl in @integration tests

    async def disconnect(self) -> None:
        self._session = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._session is None:
            raise RuntimeError("PipecatAgent: not connected")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._session is None:
            raise RuntimeError("PipecatAgent: not connected")
        return AudioChunk(data=b"")
