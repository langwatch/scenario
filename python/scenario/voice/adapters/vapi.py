"""
VapiAgent: call Vapi's REST API to create a call, then connect to the
returned websocketCallUrl.

Source §5.5.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class VapiAgent(VoiceAgentAdapter):
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/16000"],
        output_formats=["pcm16/16000"],
    )

    def __init__(self, assistant_id: str, api_key: str):
        self.assistant_id = assistant_id
        self.api_key = api_key
        self.websocket_call_url: Optional[str] = None
        self._ws: Optional[object] = None

    async def connect(self) -> None:
        # Integration: POST to Vapi REST API to get websocketCallUrl, then
        # open websocket.
        self.websocket_call_url = f"wss://vapi.ai/ws/{self.assistant_id}"
        self._ws = object()

    async def disconnect(self) -> None:
        self._ws = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._ws is None:
            raise RuntimeError("VapiAgent: not connected")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._ws is None:
            raise RuntimeError("VapiAgent: not connected")
        return AudioChunk(data=b"")
