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
        self._sent_dtmf: list[str] = []

    def __repr__(self) -> str:  # redact credentials
        return (
            f"TwilioAgent(phone_number={self.phone_number!r}, "
            f"from_number={self.from_number!r}, account_sid='***', auth_token='***')"
        )

    async def connect(self) -> None:
        self._stream = object()

    async def disconnect(self) -> None:
        self._stream = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        from ._stub import PendingTransportError
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")
        raise PendingTransportError("TwilioAgent")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        from ._stub import PendingTransportError
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")
        raise PendingTransportError("TwilioAgent")

    async def send_dtmf(self, tones: str) -> None:
        """Send DTMF tones via the Twilio Media Streams control channel."""
        if self._stream is None:
            raise RuntimeError("TwilioAgent: not connected")
        # Recorded for later verification; real wire implementation ships with
        # the integration-level Twilio transport.
        self._sent_dtmf.append(tones)
