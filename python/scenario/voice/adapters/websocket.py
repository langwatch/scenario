"""
Generic WebSocket adapter: bring-your-own protocol.

Users either subclass ``WebSocketAgentAdapter`` or pass a ``WebSocketProtocol`` that
encodes audio on the wire and decodes responses. This is the escape hatch for
custom voice backends that don't fit one of the platform-specific adapters.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class WebSocketProtocol(ABC):
    """Encoder/decoder pair for a custom WebSocket audio protocol."""

    @abstractmethod
    def encode_audio(self, audio: bytes) -> Any:
        """Convert PCM16 bytes into the wire representation the server expects."""

    @abstractmethod
    def decode_response(self, message: Any) -> Optional[AudioChunk]:
        """Parse a server message into an AudioChunk, or None if it's not audio."""


class WebSocketAgentAdapter(VoiceAgentAdapter):
    """
    Connects to an arbitrary WebSocket endpoint using a user-supplied protocol.

    The protocol's ``encode_audio`` is called before sending; ``decode_response``
    is called on each inbound frame until an AudioChunk is produced.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=False,
        native_vad=False,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self, url: str, protocol: WebSocketProtocol):
        super().__init__()
        self.url = url
        self.protocol = protocol
        self._ws: Optional[Any] = None

    async def connect(self) -> None:
        import websockets  # hard dep

        self._ws = await websockets.connect(self.url)

    async def disconnect(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._ws is None:
            raise RuntimeError(f"{type(self).__name__}: not connected")
        payload = self.protocol.encode_audio(chunk.data)
        await self._ws.send(payload)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._ws is None:
            raise RuntimeError(f"{type(self).__name__}: not connected")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = max(0.0, deadline - loop.time())
            message = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            chunk = self.protocol.decode_response(message)
            if chunk is not None:
                return chunk
