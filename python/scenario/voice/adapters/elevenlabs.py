"""
ElevenLabsAgentAdapter: connect to ElevenLabs Conversational AI via their WebSocket.

Source §5.4. Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...
Exchanges PCM16 audio chunks.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


CONVAI_URL_TEMPLATE = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"


class ElevenLabsAgentAdapter(VoiceAgentAdapter):
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self, agent_id: str, api_key: str):
        self.agent_id = agent_id
        self.api_key = api_key
        self._ws: Optional[object] = None

    @property
    def url(self) -> str:
        return CONVAI_URL_TEMPLATE.format(agent_id=self.agent_id)

    async def connect(self) -> None:
        self._ws = object()

    async def disconnect(self) -> None:
        self._ws = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        from ._stub import PendingTransportError
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")
        raise PendingTransportError("ElevenLabsAgentAdapter")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        from ._stub import PendingTransportError
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")
        raise PendingTransportError("ElevenLabsAgentAdapter")

    def __repr__(self) -> str:  # redact credentials
        return f"ElevenLabsAgentAdapter(agent_id={self.agent_id!r}, api_key='***')"
