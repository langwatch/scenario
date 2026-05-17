"""
OpenAIRealtimeAgentAdapter: direct-to-model adapter — the model IS the agent.

Source §5.6 + §7.2 L1164-1171. Unlike the other adapters which wrap a user's
running agent, this one IS the agent under test (or, when
``role=AgentRole.USER``, the voice-enabled user simulator).

Wire protocol:
- Endpoint: ``wss://api.openai.com/v1/realtime?model=<model>``
- Headers: ``Authorization: Bearer <api_key>``, ``OpenAI-Beta: realtime=v1``
- On connect: emit ``session.update`` to configure audio formats, voice,
  instructions, and tools.
- Send audio: ``input_audio_buffer.append`` with base64-encoded PCM16.
- Receive audio: loop over server events until ``response.audio.delta``;
  return decoded PCM16. Transcript events update instance attributes.
- Send text (role=USER): ``conversation.item.create`` (input_text) then
  ``response.create``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from typing import Any, ClassVar, List, Optional

from ...config.voice_models import OPENAI_REALTIME_MODEL, OPENAI_STT_MODEL
from ...types import AgentRole
from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


logger = logging.getLogger("scenario.voice.openai_realtime")

REALTIME_URL_TEMPLATE = "wss://api.openai.com/v1/realtime?model={model}"


class OpenAIRealtimeAgentAdapter(VoiceAgentAdapter):
    """
    Exercise OpenAI's Realtime API as either the agent under test
    (role=AGENT, default) or as the voice-enabled user simulator
    (role=USER, per §7.2 L1164-1171).

    When role=USER, scripted ``user("text")`` steps route text through the
    realtime session's text-input channel rather than triggering TTS.

    Transcript observability:
        - ``last_user_transcript`` — set from
          ``conversation.item.input_audio_transcription.completed``
        - ``last_agent_transcript`` — accumulated from
          ``response.audio_transcript.delta`` / reset on done

    Example::

        adapter = OpenAIRealtimeAgentAdapter(
            model=OPENAI_REALTIME_MODEL,
            voice="alloy",
            instructions="You are a helpful assistant.",
        )
        async with adapter:
            # scenario.run() feeds send_audio / recv_audio ...
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        # OpenAI Realtime exposes ``response.cancel`` as a first-class
        # interrupt event — the model stops generating immediately. Mapped
        # below in ``interrupt()``.
        interruption=True,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(
        self,
        model: str = OPENAI_REALTIME_MODEL,
        voice: str = "alloy",
        instructions: str = "",
        tools: Optional[List[Any]] = None,
        *,
        api_key: Optional[str] = None,
        role: AgentRole = AgentRole.AGENT,
    ):
        super().__init__()
        self.model = model
        self.voice = voice
        self.instructions = instructions
        self.tools = tools or []
        self.role = role  # type: ignore[misc]
        # Resolve API key: explicit param takes precedence over env var.
        self._api_key: str = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._ws: Any = None

        # Transcript observability — updated on incoming transcript events.
        self.last_user_transcript: Optional[str] = None
        self.last_agent_transcript: Optional[str] = None

        # Accumulation buffer for streaming agent transcript deltas.
        self._agent_transcript_buf: str = ""

        # Bytes appended to input_audio_buffer since last commit. Non-zero
        # means recv_audio should commit + request a response before awaiting.
        self._pending_audio_bytes: int = 0

    @property
    def url(self) -> str:
        return REALTIME_URL_TEMPLATE.format(model=self.model)

    def __repr__(self) -> str:  # redact credentials
        return (
            f"OpenAIRealtimeAgentAdapter("
            f"model={self.model!r}, "
            f"voice={self.voice!r}, "
            f"role={self.role!r}, "
            f"api_key='***')"
        )

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Open the Realtime WebSocket and send the initial session.update."""
        import websockets

        self._ws = await websockets.connect(
            self.url,
            additional_headers={
                "Authorization": f"Bearer {self._api_key}",
                "OpenAI-Beta": "realtime=v1",
            },
        )
        logger.debug("OpenAIRealtimeAgentAdapter: connected to %s", self.url)

        # Configure session: audio formats, voice, instructions, tools.
        # Disable server-side VAD so we control turn boundaries explicitly via
        # input_audio_buffer.commit + response.create after each send_audio.
        session_config: dict[str, Any] = {
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "voice": self.voice,
            "input_audio_transcription": {"model": OPENAI_STT_MODEL},
            "turn_detection": None,
        }
        if self.instructions:
            session_config["instructions"] = self.instructions
        if self.tools:
            session_config["tools"] = self.tools

        await self._ws.send(
            json.dumps({"type": "session.update", "session": session_config})
        )
        logger.debug("OpenAIRealtimeAgentAdapter: session.update sent")

    async def disconnect(self) -> None:
        """Close the WebSocket if open."""
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                # Best-effort: connection may already be half-closed or in an
                # error state when disconnect() is called. We're tearing down
                # regardless — propagating here would just leak the WS reference.
                pass
            finally:
                self._ws = None
            logger.debug("OpenAIRealtimeAgentAdapter: disconnected")

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """
        Append a PCM16 audio chunk to the model's input audio buffer.

        Only emits ``input_audio_buffer.append`` — the commit + response are
        deferred to the next ``recv_audio`` call. The scenario executor may
        call ``send_audio`` many times for a single user turn (TTS streams
        audio as chunks); committing per-chunk would confuse the server with
        sub-second turn boundaries. By deferring commit to recv_audio, we
        get one server turn per user turn.
        """
        if self._ws is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")
        b64 = base64.b64encode(chunk.data).decode()
        await self._ws.send(
            json.dumps({"type": "input_audio_buffer.append", "audio": b64})
        )
        self._pending_audio_bytes += len(chunk.data)

    async def interrupt(self) -> None:
        """Send ``response.cancel`` — the OpenAI Realtime API's first-class
        interrupt. The model stops generating audio and text immediately.
        No timing race against VAD: deterministic stop, then the next user
        turn flows normally through ``send_audio`` + ``recv_audio``.
        """
        if self._ws is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")
        await self._ws.send(json.dumps({"type": "response.cancel"}))
        logger.debug("OpenAIRealtimeAgentAdapter: sent response.cancel (interrupt)")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """
        Commit any pending audio, request a response, and return the first
        audio chunk the model produces.

        If ``send_audio`` was called since the last ``recv_audio``, this
        method commits the buffer and emits ``response.create`` before
        awaiting the reply. Subsequent recv calls without new send calls
        just await the next audio delta (for multi-chunk responses).

        Loops over incoming events until a ``response.audio.delta`` event
        arrives, then returns decoded PCM16. Transcript events update the
        instance's ``last_user_transcript`` / ``last_agent_transcript``
        attributes. An ``error`` event raises a ``RuntimeError``. All other
        housekeeping events are ignored and the loop continues.

        Raises:
            asyncio.TimeoutError: if no audio arrives within ``timeout``.
            RuntimeError: if the server sends an error event.
        """
        if self._ws is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")

        # If send_audio was called since last recv, commit and request response.
        if self._pending_audio_bytes > 0:
            await self._ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            await self._ws.send(json.dumps({"type": "response.create"}))
            self._pending_audio_bytes = 0

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError(
                    "OpenAIRealtimeAgentAdapter: recv_audio timed out"
                )

            raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            try:
                event = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
            except Exception:
                logger.debug(
                    "OpenAIRealtimeAgentAdapter: non-JSON message, skipping"
                )
                continue

            etype = event.get("type", "")

            if etype == "response.audio.delta":
                # Base64-encoded PCM16 audio fragment from the model.
                b64 = event.get("delta", "")
                pcm = base64.b64decode(b64)
                # Enforce PCM16 invariant: even byte count.
                if len(pcm) % 2 == 1:
                    pcm = pcm[:-1]
                return AudioChunk(data=pcm)

            elif etype == "response.audio_transcript.delta":
                # Accumulate streaming agent transcript.
                self._agent_transcript_buf += event.get("delta", "")

            elif etype == "response.audio_transcript.done":
                # Finalise; the `transcript` field may have the full text.
                transcript = event.get("transcript", "")
                if transcript:
                    self.last_agent_transcript = transcript
                elif self._agent_transcript_buf:
                    self.last_agent_transcript = self._agent_transcript_buf
                self._agent_transcript_buf = ""

            elif etype == "conversation.item.input_audio_transcription.completed":
                # User-side transcript from Whisper.
                self.last_user_transcript = event.get("transcript", "")

            elif etype == "error":
                error_detail = event.get("error", {})
                msg = error_detail.get("message", str(error_detail))
                raise RuntimeError(
                    f"OpenAIRealtimeAgentAdapter: server error — {msg}"
                )

            else:
                # Housekeeping events — session.created, session.updated,
                # response.created, response.output_item.added, etc. — are
                # benign. Log at DEBUG and keep the loop running.
                logger.debug(
                    "OpenAIRealtimeAgentAdapter: ignoring event type %r", etype
                )

    async def send_text(self, text: str) -> None:
        """
        Inject scripted text into the realtime session as a user message.

        Used when this adapter is the user simulator (role=USER): scripted
        ``user("text")`` steps route through here instead of spawning TTS.
        The model synthesises the text into spoken audio with natural prosody,
        which is then delivered via ``recv_audio``.

        NOTE: per §7.2, OpenAI Realtime cannot populate assistant audio
        messages retroactively; the downstream transcript reflects what the
        model actually emitted, not what was scripted.

        Raises:
            RuntimeError: if called before ``connect()``.
        """
        if self._ws is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")

        # Create a user conversation item with the scripted text.
        await self._ws.send(
            json.dumps(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": text}],
                    },
                }
            )
        )
        # Prompt the model to generate audio output.
        await self._ws.send(json.dumps({"type": "response.create"}))
        logger.debug(
            "OpenAIRealtimeAgentAdapter: send_text injected %r", text[:60]
        )
