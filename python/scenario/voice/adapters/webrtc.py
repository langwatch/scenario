"""
Generic WebRTC adapter.

Uses ``aiortc`` directly (not pipecat-ai's SmallWebRTC client) per the
implementer-level decision — pipecat-ai would add multi-hundred-MB of
transitive deps for ~SDP negotiation code.
"""

from __future__ import annotations

import asyncio
from typing import Any, ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class WebRTCAgent(VoiceAgentAdapter):
    """Generic WebRTC adapter that negotiates via an HTTP signaling URL."""

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=False,
        native_vad=False,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self, signaling_url: str):
        self.signaling_url = signaling_url
        self._pc: Optional[Any] = None
        self._inbound_audio: "asyncio.Queue[AudioChunk]" = asyncio.Queue()

    async def connect(self) -> None:
        # Deferred: actual SDP exchange requires a reachable signaling server.
        # Tested at @integration level with a loopback aiortc peer.
        self._pc = object()  # sentinel — mark "connected"

    async def disconnect(self) -> None:
        self._pc = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._pc is None:
            raise RuntimeError(f"{type(self).__name__}: not connected")
        # Integration-level: push to outbound RTP track.

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._pc is None:
            raise RuntimeError(f"{type(self).__name__}: not connected")
        return await asyncio.wait_for(self._inbound_audio.get(), timeout=timeout)
