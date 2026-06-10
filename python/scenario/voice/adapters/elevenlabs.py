"""
ElevenLabsAgentAdapter: connect to ElevenLabs Conversational AI via their WebSocket.

Source §5.4. Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...
Exchanges PCM16 audio chunks.

Wire protocol:
- Send: JSON ``{"user_audio_chunk": "<base64 PCM16>"}``
- Recv events:
  - ``conversation_initiation_metadata`` — checked for audio-format
    mismatch against advertised capability; warning logged on drift
  - ``user_transcript`` / ``agent_response`` — text captured on
    ``last_user_transcript`` / ``last_agent_transcript`` for observability
  - ``agent_response_correction`` — corrected text replaces
    ``last_agent_transcript`` (post-barge-in update)
  - ``audio`` — decoded and returned from ``recv_audio``
  - ``ping`` — replied to with ``{"type": "pong", "event_id": <id>}``
  - ``interruption`` — swallowed
  - Other documented events (``vad_score``, ``client_tool_call``,
    ``agent_response_metadata``, etc.) — silently skipped; the
    provisioned test agent doesn't trigger them.
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
    ElevenLabs **hosted** Conversational AI adapter.

    Connects to ElevenLabs' hosted endpoint where the STT→LLM→TTS loop runs
    on their infrastructure. All audio is PCM16 @ 24kHz mono — no conversion
    needed at either edge.

    Not to be confused with :class:`ElevenLabsVoiceAgent` (in
    ``scenario.voice.adapters.composable``), which is the typed composable
    preset that runs locally with separate STT, LLM, and TTS providers. The
    two complement each other:

    - ``ElevenLabsAgentAdapter`` (this class): black-box hosted EL ConvAI;
      you provide an ``agent_id`` provisioned in the EL dashboard and EL
      runs the whole pipeline server-side.
    - :class:`ElevenLabsVoiceAgent`: composes ``ElevenLabsSTTProvider`` +
      any LLM + ElevenLabs TTS on your side; you control the prompts,
      model choice, and tool calls.

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
        super().__init__()
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

        We send ``conversation_initiation_client_data`` on every connect.
        The EL docs neither require nor forbid this (the reference SDK
        sample sends it unconditionally with an empty body); empirically
        we've seen ``first_message`` skipped on bare connects and reliably
        fire when the init message is sent, even with an empty override
        block. If EL's behavior changes, this is the first thing to
        revisit.
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
                # Best-effort: connection may already be half-closed or
                # in an error state when disconnect() is called. We're
                # tearing down regardless — propagating here would just
                # leak the WS reference.
                pass
            finally:
                self._ws = None
            logger.debug("ElevenLabsAgentAdapter: disconnected")

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Send a PCM16 audio chunk encoded as base64 in a JSON message.

        Empirically, EL ConvAI stops responding to subsequent turns if
        the client sends only a single chunk and never signals end of
        turn. The EL docs document no client-driven end-of-turn signal
        (server-side VAD is supposed to handle it) but in practice the
        VAD only fires after enough silence has been observed. We
        append a fixed-size tail of zero-bytes after every chunk to
        provide that silence signal.

        Tail size: 16000 zero bytes — empirically the sweet spot.
        - Removing the tail entirely: EL stops responding to user
          turns after the greeting.
        - Doubling to 24000 bytes (a "true 500ms" at the provisioned
          pcm_24000 rate): EL stops responding mid-conversation, same
          stall pattern.
        - 16000 bytes at pcm_24000 = ~333ms of silence: reliable.

        If EL ever exposes an explicit end-of-turn message we should
        switch to that instead.
        """
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        # 1. Speech.
        b64 = base64.b64encode(chunk.data).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": b64}))

        # 2. Silence tail. See docstring for size rationale.
        silence = b"\x00" * 16000
        silence_b64 = base64.b64encode(silence).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": silence_b64}))

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """
        Receive the next audio chunk from ElevenLabs.

        ``timeout`` bounds **inter-message silence** — the maximum gap between
        any two received frames — NOT the total duration of the call. Every
        received frame (**keep-alive pings included**) resets the idle
        deadline, so this returns when an ``audio`` event arrives and raises
        :class:`asyncio.TimeoutError` only after ``timeout`` seconds elapse
        with **no message of any kind**. Pings are replied to inline;
        transcript events update instance attributes for observability; all
        other event types are swallowed without error.

        Design decision (issue #493 — intentional, not an oversight): because
        a received ping is treated as proof of liveness, a hosted agent that
        keeps pinging but never sends audio (e.g. a wedged tool/RAG call) will
        make this method wait **indefinitely**. There is deliberately **no
        total-duration ceiling** here — a legitimate 30s+ silent-but-pinging
        stretch must not abort the turn, which a cumulative budget would do.
        The caller's ``response_max_duration`` is checked *between*
        ``recv_audio`` calls and does **not** bound a single in-progress recv.
        (An absolute caller-side backstop for the wedged-agent case is tracked
        as a separate follow-up; it is intentionally not implemented here.)
        """
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("ElevenLabsAgentAdapter: recv_audio timed out")

            raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            # A received message (ping included) proves the socket is alive, so
            # re-arm the idle deadline. Placed BEFORE json.loads so ANY frame —
            # even a non-JSON/malformed one — counts as a liveness signal.
            deadline = asyncio.get_running_loop().time() + timeout
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
                # Per EL docs, ping wire shape is
                #   {"type": "ping", "ping_event": {"event_id": <int>, "ping_ms": <int>}}
                # Pong must echo the event_id at the top level. The
                # fallback to top-level event_id covers any older shape.
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

            elif etype == "conversation_initiation_metadata":
                # EL reports the agent's actual configured audio formats
                # here. Our adapter capabilities advertise pcm16/24000,
                # matching the test agent we provision. If a caller
                # points the adapter at an agent configured differently,
                # this is where the mismatch becomes visible — warn so
                # the codec mismatch is logged rather than silently
                # garbling audio.
                #
                # Wire shape (per docs):
                #   {"type": "conversation_initiation_metadata",
                #    "conversation_initiation_metadata_event": {
                #      "conversation_id": "...",
                #      "agent_output_audio_format": "pcm_24000",
                #      "user_input_audio_format": "pcm_24000"}}
                meta = event.get("conversation_initiation_metadata_event", {}) or {}
                out_fmt = meta.get("agent_output_audio_format")
                in_fmt = meta.get("user_input_audio_format")
                if out_fmt and out_fmt != "pcm_24000":
                    logger.warning(
                        "ElevenLabsAgentAdapter: agent_output_audio_format=%r "
                        "differs from advertised pcm16/24000 capability; "
                        "audio may pitch-shift or fail to decode.",
                        out_fmt,
                    )
                if in_fmt and in_fmt != "pcm_24000":
                    logger.warning(
                        "ElevenLabsAgentAdapter: user_input_audio_format=%r "
                        "differs from advertised pcm16/24000 capability; "
                        "the agent may not understand audio we send.",
                        in_fmt,
                    )

            elif etype == "interruption":
                pass  # documented non-audio event, no action needed

            else:
                logger.debug("ElevenLabsAgentAdapter: unknown event type %r, skipping", etype)
