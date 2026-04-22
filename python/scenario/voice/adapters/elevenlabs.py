"""
ElevenLabsAgentAdapter: connect to ElevenLabs Conversational AI via their WebSocket.

Source §5.4. Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...
Exchanges PCM16 audio chunks.

Wire protocol:
- Send: JSON ``{"user_audio_chunk": "<base64 PCM16>"}``
- Recv events:
  - ``conversation_initiation_metadata``, ``user_transcript``, ``agent_response`` — swallowed
    (transcripts tracked on the instance for downstream observability)
  - ``audio`` — decoded and returned from ``recv_audio``
  - ``ping`` — replied to with ``{"type": "pong", "event_id": <id>}``
  - ``interruption`` — swallowed
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, ClassVar, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


logger = logging.getLogger("scenario.voice.elevenlabs")

CONVAI_URL_TEMPLATE = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"


class ElevenLabsAgentAdapter(VoiceAgentAdapter):
    """
    ElevenLabs Conversational AI adapter.

    Connects to ElevenLabs' hosted endpoint where the STT→LLM→TTS loop runs
    on their infrastructure. All audio is PCM16 @ 24kHz mono — no conversion
    needed at either edge.

    Intermediate transcripts are tracked on ``last_user_transcript`` and
    ``last_agent_transcript`` for scenario observability.

    Example::

        adapter = ElevenLabsAgentAdapter(agent_id="abc123", api_key="sk-...")
        async with adapter:
            # scenario.run() feeds send_audio / recv_audio ...
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(self, agent_id: str, api_key: str) -> None:
        self.agent_id = agent_id
        self.api_key = api_key
        self._ws: Any = None

        # Transcript observability — updated on each transcript event.
        self.last_user_transcript: Optional[str] = None
        self.last_agent_transcript: Optional[str] = None

    @property
    def url(self) -> str:
        return CONVAI_URL_TEMPLATE.format(agent_id=self.agent_id)

    def __repr__(self) -> str:  # redact credentials
        return f"ElevenLabsAgentAdapter(agent_id={self.agent_id!r}, api_key='***')"

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Open the WebSocket to ElevenLabs' ConvAI endpoint."""
        import websockets

        self._ws = await websockets.connect(
            self.url,
            additional_headers={"xi-api-key": self.api_key},
        )
        logger.debug("ElevenLabsAgentAdapter: connected to %s", self.url)

    async def disconnect(self) -> None:
        """Close the WebSocket if open."""
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            finally:
                self._ws = None
            logger.debug("ElevenLabsAgentAdapter: disconnected")

    async def __aenter__(self) -> "ElevenLabsAgentAdapter":
        await self.connect()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.disconnect()

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Send a PCM16 audio chunk encoded as base64 in a JSON message."""
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")
        b64 = base64.b64encode(chunk.data).decode()
        msg = json.dumps({"user_audio_chunk": b64})
        await self._ws.send(msg)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """
        Receive the next audio chunk from ElevenLabs.

        Loops over incoming events until an ``audio`` event arrives or
        ``timeout`` expires. Pings are replied to inline; transcript events
        update instance attributes for observability; all other event types
        are swallowed without error.
        """
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("ElevenLabsAgentAdapter: recv_audio timed out")

            raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            try:
                event = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
            except Exception:
                logger.debug("ElevenLabsAgentAdapter: non-JSON message, skipping")
                continue

            etype = event.get("type", "")

            if etype == "audio":
                audio_event = event.get("audio_event", {})
                b64 = audio_event.get("audio_base_64", "")
                pcm = base64.b64decode(b64)
                # Ensure even byte count (PCM16 invariant).
                if len(pcm) % 2 == 1:
                    pcm = pcm[:-1]
                return AudioChunk(data=pcm)

            elif etype == "ping":
                event_id = event.get("event_id")
                pong = json.dumps({"type": "pong", "event_id": event_id})
                await self._ws.send(pong)

            elif etype == "user_transcript":
                self.last_user_transcript = event.get("user_transcription_event", {}).get("user_transcript")

            elif etype == "agent_response":
                self.last_agent_transcript = event.get("agent_response_event", {}).get("agent_response")

            elif etype in ("conversation_initiation_metadata", "interruption"):
                pass  # expected non-audio events

            else:
                logger.debug("ElevenLabsAgentAdapter: unknown event type %r, skipping", etype)
