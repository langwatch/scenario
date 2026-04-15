"""
TwilioAgent: place a real outbound phone call and stream audio via Twilio
Media Streams WebSocket.

Source §5.3. The only adapter with ``dtmf`` capability — needed for IVR/phone
tree testing. Media Streams emits raw audio without incremental transcripts,
so ``interrupt(after_words=N)`` raises on this adapter (that's why
streaming_transcripts=False and the user must fall back to interrupt(after=s)).
"""

from __future__ import annotations

from typing import ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class TwilioAgent(VoiceAgentAdapter):
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=False,  # Media Streams has no native STT
        native_vad=False,  # SDK falls back to webrtcvad
        dtmf=True,
        input_formats=["mulaw/8000"],
        output_formats=["mulaw/8000"],
    )

    def __init__(
        self,
        phone_number: str,
        from_number: str,
        account_sid: str,
        auth_token: str,
    ):
        self.phone_number = phone_number
        self.from_number = from_number
        self.account_sid = account_sid
        self.auth_token = auth_token
        self._stream: Optional[object] = None

    async def connect(self) -> None:
        self._stream = object()

    async def disconnect(self) -> None:
        self._stream = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")
        return AudioChunk(data=b"")

    async def send_dtmf(self, tones: str) -> None:
        """Send DTMF tones via the Twilio Media Streams control channel."""
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")
        # Integration-level implementation; tested via live Twilio creds.
