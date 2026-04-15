"""
GeminiLiveAgent: direct-to-model adapter for Gemini Live native-audio.

Source §5.6.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class GeminiLiveAgent(VoiceAgentAdapter):
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/16000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(
        self,
        model: str = "gemini-2.5-flash-native-audio",
        voice: str = "Algieba",
        system_instruction: str = "",
    ):
        self.model = model
        self.voice = voice
        self.system_instruction = system_instruction
        self._session: Optional[object] = None

    async def connect(self) -> None:
        self._session = object()

    async def disconnect(self) -> None:
        self._session = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        from ._stub import PendingTransportError
        if self._session is None:
            raise RuntimeError("GeminiLiveAgent: not connected")
        raise PendingTransportError("GeminiLiveAgent")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        from ._stub import PendingTransportError
        if self._session is None:
            raise RuntimeError("GeminiLiveAgent: not connected")
        raise PendingTransportError("GeminiLiveAgent")
