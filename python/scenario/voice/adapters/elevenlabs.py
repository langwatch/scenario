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

    def __init__(
        self,
        agent_id: str,
        api_key: str,
        *,
        system_prompt_override: Optional[str] = None,
        first_message_override: Optional[str] = None,
    ) -> None:
        self.agent_id = agent_id
        self.api_key = api_key
        # Per-session overrides applied via conversation_initiation_client_data
        # at the start of every WS connect. Used by demos that need a
        # different prompt shape (e.g. verbose for interrupt demos) without
        # mutating the shared test agent's persistent config.
        self._system_prompt_override = system_prompt_override
        self._first_message_override = first_message_override
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
        """Open the WebSocket to ElevenLabs' ConvAI endpoint.

        After the WS opens, we ALWAYS send ``conversation_initiation_client_data``
        — even when there are no per-session overrides. EL's behavior on
        a bare connect is inconsistent: sometimes ``first_message`` is sent
        immediately, sometimes EL waits for client audio to "wake" the
        session and then skips the greeting entirely. Sending the
        initiation message (even with an empty override block) reliably
        triggers ``first_message`` to fire on connect, which is what every
        demo expects when its script leads with a ``scenario.agent()``
        greeting drain.
        """
        import websockets

        self._ws = await websockets.connect(
            self.url,
            additional_headers={"xi-api-key": self.api_key},
        )
        logger.debug("ElevenLabsAgentAdapter: connected to %s", self.url)

        agent_override: dict[str, Any] = {}
        if self._system_prompt_override:
            agent_override["prompt"] = {"prompt": self._system_prompt_override}
        if self._first_message_override:
            agent_override["first_message"] = self._first_message_override

        init = {
            "type": "conversation_initiation_client_data",
            "conversation_config_override": {"agent": agent_override},
        }
        await self._ws.send(json.dumps(init))
        logger.debug(
            "ElevenLabsAgentAdapter: sent conversation_initiation_client_data with overrides=%s",
            list(agent_override.keys()) or "none",
        )

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
        """Send a PCM16 audio chunk encoded as base64 in a JSON message.

        After the speech audio is on the wire, append a short tail of
        silent PCM16 to cue EL's server-side VAD that the user turn is
        complete. Without this nudge, EL holds the turn open waiting for
        more speech and never emits a reply — especially after an
        interruption, where the silence-only signal is what tells EL to
        re-engage turn-taking.

        Tail length: 500ms is empirically enough for EL's VAD threshold.
        """
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        # 1. Speech.
        b64 = base64.b64encode(chunk.data).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": b64}))

        # 2. 500ms of silence at 16kHz mono PCM16 = 16000 samples/s × 0.5s
        # × 2 bytes/sample = 16000 bytes. EL's docstring says PCM16/16k for
        # user audio; if a different sample rate is in play, this still
        # works because we're just emitting zero-bytes, which any sane VAD
        # treats as silence regardless of rate misalignment.
        silence = b"\x00" * 16000
        silence_b64 = base64.b64encode(silence).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": silence_b64}))

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
            logger.debug("ElevenLabsAgentAdapter: recv event %s", etype)

            if etype == "audio":
                audio_event = event.get("audio_event", {})
                b64 = audio_event.get("audio_base_64", "")
                pcm = base64.b64decode(b64)
                # Ensure even byte count (PCM16 invariant).
                if len(pcm) % 2 == 1:
                    pcm = pcm[:-1]
                return AudioChunk(data=pcm)

            elif etype == "ping":
                # ElevenLabs ConvAI ping shape (v1, observed 2026-05):
                #   {"type": "ping", "ping_event": {"event_id": <int>, "ping_ms": <int>}}
                # The previous code looked for "event_id" at the top level,
                # which yielded null — EL then rejected our pong with a
                # 1008 policy violation: "event_id: Input should be a valid
                # integer". Source the id from ping_event.event_id; fall
                # back to top-level for older shapes.
                ping_event = event.get("ping_event") or {}
                event_id = ping_event.get("event_id")
                if event_id is None:
                    event_id = event.get("event_id")
                if event_id is None:
                    logger.debug("ElevenLabsAgentAdapter: ping with no event_id, skipping pong: %r", event)
                    continue
                pong = json.dumps({"type": "pong", "event_id": event_id})
                await self._ws.send(pong)

            elif etype == "user_transcript":
                self.last_user_transcript = event.get("user_transcription_event", {}).get("user_transcript")

            elif etype == "agent_response":
                self.last_agent_transcript = event.get("agent_response_event", {}).get("agent_response")

            elif etype == "agent_response_correction":
                # EL signals a corrected agent reply (post server-side
                # barge-in detection). The corrected text replaces the
                # last_agent_transcript so consumers see what the agent
                # ACTUALLY said after our interrupt landed, not the
                # pre-correction draft.
                #
                # Wire shape:
                #   {"type": "agent_response_correction",
                #    "agent_response_correction_event": {
                #      "original_agent_response": "...",
                #      "corrected_agent_response": "..."}}
                correction = event.get("agent_response_correction_event", {}) or {}
                corrected = correction.get("corrected_agent_response")
                if corrected:
                    self.last_agent_transcript = corrected

            elif etype in ("conversation_initiation_metadata", "interruption"):
                pass  # expected non-audio events

            else:
                logger.debug("ElevenLabsAgentAdapter: unknown event type %r, skipping", etype)
