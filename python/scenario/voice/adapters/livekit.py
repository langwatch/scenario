"""
LiveKitAgentAdapter: join a LiveKit room as a participant and exchange audio.

Source §5.2. Publishes user-simulator audio to the room; subscribes to the
agent-under-test's audio track.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities
from ._stub import PendingTransportError


class LiveKitAgentAdapter(VoiceAgentAdapter):
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/48000"],
        output_formats=["pcm16/48000"],
    )

    def __init__(self, url: str, api_key: str, api_secret: str, room: str):
        super().__init__()
        self.url = url
        self.api_key = api_key
        self.api_secret = api_secret
        self.room = room
        self._room: Optional[object] = None

    def __repr__(self) -> str:  # redact credentials
        return f"LiveKitAgentAdapter(url={self.url!r}, room={self.room!r}, api_key='***', api_secret='***')"

    async def connect(self) -> None:
        self._room = object()

    async def disconnect(self) -> None:
        self._room = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._room is None:
            raise RuntimeError("LiveKitAgentAdapter: not connected")
        raise PendingTransportError("LiveKitAgentAdapter")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._room is None:
            raise RuntimeError("LiveKitAgentAdapter: not connected")
        raise PendingTransportError("LiveKitAgentAdapter")
