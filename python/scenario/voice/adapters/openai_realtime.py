"""
OpenAIRealtimeAgentAdapter: direct-to-model adapter — the model IS the agent.

Source §5.6 + §7.2 L1164-1171. Unlike the other adapters which wrap a user's
running agent, this one IS the agent under test (or, when
``role=AgentRole.USER``, the voice-enabled user simulator).

Wire protocol (GA, post-2026-05-12):
- Endpoint: ``wss://api.openai.com/v1/realtime?model=<model>``
- Headers: ``Authorization: Bearer <api_key>`` only (no ``OpenAI-Beta`` header).
- On connect: emit ``session.update`` to configure session type, audio formats,
  voice, instructions, and tools. ``session.type="realtime"``; audio config
  nested under ``session.audio.{input,output}`` with object format descriptors
  (e.g. ``{"type": "audio/pcm", "rate": 24000}``).
- Send audio: ``input_audio_buffer.append`` with base64-encoded PCM16.
- Receive audio: loop over server events until ``response.output_audio.delta``
  (GA name); legacy ``response.audio.delta`` accepted defensively with a
  one-time warning. Return decoded PCM16.
- Transcript events: ``response.output_audio_transcript.delta`` /
  ``response.output_audio_transcript.done`` update instance attributes.
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
          ``response.output_audio_transcript.delta`` / reset on done

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
        speaks_first: bool = False,
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

        # Tracks which legacy (pre-GA) event names have already triggered a
        # one-time warning, so the log isn't spammed on every audio frame.
        self._legacy_events_warned: set[str] = set()

        # --- Gap 1: agent-speaks-first support ---
        # When speaks_first=True, the adapter is configured for an agent-initiated
        # scenario where the agent must speak first without any user audio.
        self._speaks_first: bool = speaks_first

        # True while a response is in flight (set on response.created, cleared on
        # response.done / response.cancelled). Prevents double-firing response.create
        # and allows drain re-entries after a completed response to return empty
        # (clean drain exit).
        self._response_active: bool = False

        # Set to True the first time response.created is received. Guards the
        # drain re-entry short-circuit in recv_audio: the empty-chunk early-return
        # must only fire AFTER at least one response has been active and completed,
        # not on the very first recv_audio call (which would break direct-call
        # tests that don't go through notify_agent_turn).
        self._response_ever_active: bool = False

        # Per-turn signal: set by notify_agent_turn() before each agent step so
        # recv_audio knows this is a genuine agent-initiated turn (not a silent
        # proceed()/resume). Consumed (cleared) when the kick fires.
        self._agent_turn_pending: bool = speaks_first  # first turn armed if speaks_first

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

    def _warn_if_legacy(self, received: str, ga_name: str) -> None:
        """Emit a one-time WARNING when a pre-GA (beta) event name is seen.

        Only fires once per distinct legacy name per adapter instance, so a
        multi-chunk audio response doesn't flood the log. The GA-named event
        itself never triggers a warning.
        """
        if received != ga_name and received not in self._legacy_events_warned:
            self._legacy_events_warned.add(received)
            logger.warning(
                "OpenAIRealtimeAgentAdapter: received legacy event %r; "
                "GA uses %r — accepting defensively",
                received,
                ga_name,
            )

    def notify_agent_turn(self) -> None:
        """Signal that an agent turn is about to be dispatched.

        Called by the executor before each agent step so recv_audio can fire
        a bare response.create for agent-initiated turns (where no user audio
        has been committed). This per-turn signal handles both turn 1 (opening)
        and subsequent agent turns in multi-turn scripts like [agent(), user(),
        agent()].

        Only meaningful when role=AGENT. Safe to call on every agent step —
        recv_audio consumes and clears the flag.
        """
        if self.role == AgentRole.AGENT:
            self._agent_turn_pending = True

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Open the Realtime WebSocket and send the initial session.update."""
        import websockets

        self._ws = await websockets.connect(
            self.url,
            additional_headers={
                "Authorization": f"Bearer {self._api_key}",
            },
        )
        logger.debug("OpenAIRealtimeAgentAdapter: connected to %s", self.url)

        # Configure session: audio formats, voice, instructions, tools.
        # Disable server-side VAD (session.audio.input.turn_detection=None) so
        # we control turn boundaries explicitly via input_audio_buffer.commit +
        # response.create after each send_audio.
        session_config: dict[str, Any] = {
            "type": "realtime",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "turn_detection": None,
                    "transcription": {"model": OPENAI_STT_MODEL},
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "voice": self.voice,
                },
            },
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

        Loops over incoming events until a ``response.output_audio.delta``
        event arrives (GA name), then returns decoded PCM16. The legacy
        ``response.audio.delta`` name is accepted defensively with a one-time
        warning. Transcript events update the instance's
        ``last_user_transcript`` / ``last_agent_transcript`` attributes.
        An ``error`` event raises a ``RuntimeError``. All other housekeeping
        events are ignored and the loop continues.

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
            self._agent_turn_pending = False  # user spoke → per-turn signal consumed

        # Gap 1: agent-speaks-first / multi-turn agent initiation.
        # When the executor signals an agent turn via notify_agent_turn() and
        # no user audio has been committed and no response is already in flight,
        # send a bare content-free response.create so the model speaks.
        # Opening words come from the session instructions — no text is injected.
        # Self-limiting on user-first scripts: if user audio was committed above,
        # _agent_turn_pending was already cleared.
        # Also serves as the clean drain exit: if a response already completed
        # (_response_active is False after response.done cleared it) and
        # _agent_turn_pending is False, a drain re-entry returns an empty chunk.
        elif self._agent_turn_pending and not self._response_active:
            await self._ws.send(json.dumps({"type": "response.create"}))
            self._agent_turn_pending = False
            self._response_active = True

        elif not self._agent_turn_pending and not self._response_active and self._response_ever_active:
            # No pending audio, no agent-turn signal, no response in flight,
            # AND at least one response has already completed this session:
            # this is a drain re-entry after a completed response. Return empty
            # chunk so _drain_agent_response's tail-silence loop exits cleanly.
            # Guard on _response_ever_active so that a fresh recv_audio call
            # (before any response.created fires) does NOT short-circuit —
            # that would break direct recv_audio callers (e.g. unit tests that
            # call recv_audio without going through notify_agent_turn).
            return AudioChunk(data=b"")

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

            if etype in ("response.output_audio.delta", "response.audio.delta"):
                # Accept both the GA event name and its retired beta alias —
                # live gpt-realtime* models have been observed still emitting
                # the beta names. These legacy arms should be removed once the
                # GA names are confirmed stable at a live endpoint (issue #602).
                self._warn_if_legacy(etype, "response.output_audio.delta")
                b64 = event.get("delta", "")
                pcm = base64.b64decode(b64)
                # Enforce PCM16 invariant: even byte count.
                if len(pcm) % 2 == 1:
                    pcm = pcm[:-1]
                return AudioChunk(data=pcm)

            elif etype == "response.created":
                # Response is now in flight — mark it so subsequent recv_audio
                # drain re-entries don't fire a spurious second response.create.
                self._response_active = True
                self._response_ever_active = True

            elif etype in (
                "response.output_audio_transcript.delta",
                "response.audio_transcript.delta",
            ):
                # Accumulate streaming agent transcript.
                self._warn_if_legacy(etype, "response.output_audio_transcript.delta")
                self._agent_transcript_buf += event.get("delta", "")

            elif etype in (
                "response.output_audio_transcript.done",
                "response.audio_transcript.done",
            ):
                # Finalise; the `transcript` field may have the full text.
                self._warn_if_legacy(etype, "response.output_audio_transcript.done")
                transcript = event.get("transcript", "")
                if transcript:
                    self.last_agent_transcript = transcript
                elif self._agent_transcript_buf:
                    self.last_agent_transcript = self._agent_transcript_buf
                self._agent_transcript_buf = ""

            elif etype in ("response.done", "response.cancelled"):
                # Response finished or was cancelled — mark it so the next
                # drain re-entry returns an empty chunk (clean exit).
                self._response_active = False

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
                # response.output_item.added, etc. — are benign. Log at DEBUG
                # and keep the loop running.
                logger.debug(
                    "OpenAIRealtimeAgentAdapter: ignoring event type %r", etype
                )

    async def _drain_agent_response(
        self, on_first_chunk=None
    ) -> "AudioChunk":
        """Override to surface the spoken transcript after draining.

        The base class drains recv_audio chunks until tail silence. After
        draining, ``response.output_audio_transcript.done`` will have already
        fired (it arrives before ``response.done``), so ``self.last_agent_transcript``
        is populated. We rebuild the merged chunk with ``transcript=`` set so
        ``create_audio_message`` attaches a text part to the assistant message.

        This puts the transcript in ``result.messages`` (AC2/AC5) without
        modifying messages.py, tts.py, or composable.py (AC6).

        The transcript text is an ordinary ``{"type":"text","text":...}`` part —
        no extra keys. Echo-safety is handled in ``_strip_audio_content``
        (user_simulator_agent.py) by detecting the structural pattern: an
        assistant message that carries both an ``input_audio`` part AND a ``text``
        part is a voiced agent turn, so the text is reframed as third-person
        context before ``reverse_roles`` runs (AC4/AC11).
        """
        from ..audio_chunk import AudioChunk as _AudioChunk

        # Clear transcript state at the start of each turn so a stale value
        # from a prior turn doesn't bleed through if this turn's event never
        # fires (AC8: degraded case — absent transcript → no text part).
        self.last_agent_transcript = None
        self._agent_transcript_buf = ""

        merged = await super()._drain_agent_response(on_first_chunk=on_first_chunk)

        transcript = self.last_agent_transcript
        if transcript:
            # Rebuild with transcript attached so create_audio_message adds
            # the text part. The original merged.data is unchanged.
            return _AudioChunk(data=merged.data, transcript=transcript)
        # No transcript (AC8): return the merge unchanged (audio-only).
        return merged

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
