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
from typing import Any, ClassVar, Dict, List, Optional, Union, cast

from openai.types.chat import ChatCompletionMessageParam

from ...config.voice_models import OPENAI_REALTIME_MODEL, OPENAI_STT_MODEL
from ...types import AgentInput, AgentReturnTypes, AgentRole
from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..broker import (
    REALTIME_MINT_PATH,
    RealtimeMintEndpoint,
    accumulate_realtime_usage,
    close_unused_realtime_session,
    mint_openai_realtime_session,
    report_openai_realtime_usage,
    resolve_realtime_mint_endpoint,
    warn_direct_dial_fallback,
)
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
        mint: Union[RealtimeMintEndpoint, bool, None] = None,
    ):
        super().__init__()
        self.model = model
        self.voice = voice
        self.instructions = instructions
        self.tools = tools or []
        self.role = role  # type: ignore[misc]
        # The fallback key for dialling the vendor directly: explicit param,
        # then OPENAI_REALTIME_API_KEY, then OPENAI_API_KEY.
        # OPENAI_REALTIME_API_KEY exists so a deployment whose OPENAI_API_KEY
        # is a virtual key can still hold a real provider key for this socket.
        #
        # A minted session uses none of these on the socket. It dials with the
        # ephemeral secret the mint returned, so a long-lived key never
        # reaches the socket. See ``mint``.
        self._api_key: str = (
            api_key
            or os.environ.get("OPENAI_REALTIME_API_KEY")
            or os.environ.get("OPENAI_API_KEY", "")
        )
        # Which of the three the key came from. Only used to name it in the
        # direct-dial warning, where naming the wrong one sends the reader to
        # a variable that is not set.
        self._api_key_source: str = (
            "the api_key passed to the adapter"
            if api_key is not None
            else (
                "OPENAI_REALTIME_API_KEY"
                if os.environ.get("OPENAI_REALTIME_API_KEY")
                else "OPENAI_API_KEY"
            )
        )
        # Where to mint the session credential. ``False`` skips the mint and
        # dials the vendor directly; an explicit endpoint overrides
        # OPENAI_BASE_URL and OPENAI_API_KEY; ``None`` resolves from those two.
        #
        # ``POST /v1/realtime/client_secrets`` is OpenAI's own path, and a
        # LangWatch AI Gateway mirrors it, so the same request works against
        # either. Against OpenAI it returns an ephemeral client secret.
        # Against a gateway it also checks the virtual key's budget and
        # open-session cap and opens one spend record, naming the session on
        # the ``X-LangWatch-Session-Id`` response header. Usage is reported
        # back only when that header is present.
        self._mint: Optional[RealtimeMintEndpoint]
        if mint is False:
            self._mint = None
        elif isinstance(mint, RealtimeMintEndpoint):
            self._mint = mint
        else:
            self._mint = resolve_realtime_mint_endpoint()
        #: The gateway's id for the current session, empty unless a gateway
        #: minted it.
        self._broker_session_id: str = ""
        #: What the socket has reported so far this session, summed across
        #: responses and sent when the session ends.
        self._session_usage: Optional[Dict[str, Any]] = None
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

        # Issue #657: distinct deferral flag for the user-audio race guard.
        # Set when user audio arrives while a response is in flight; cleared and
        # consumed in the response.done/cancelled handler to fire the deferred
        # response.create.  Kept separate from _agent_turn_pending so each flag
        # retains its single original meaning.
        # Known limitation: a second user-audio commit while one create is already
        # deferred collapses into this single boolean.  Manual-VAD single-turn flow
        # makes that path unreachable in practice; FSM refactor tracked as follow-up.
        self._deferred_response_create: bool = False

        # --- Issue #630: realtime function-call (tool-call) surfacing ---
        # In-progress function calls keyed by call_id. Each value is a dict
        # {"name": str|None, "arguments": str} assembled from the streaming
        # `response.function_call_arguments.delta`/`.done` events and the
        # `response.output_item.added`/`.done` (function_call item) events.
        # recv_audio() returns an AudioChunk, so it cannot carry tool calls in
        # its return value — instead the function-call branches accumulate here
        # and the overridden call() drains them into result.messages.
        self._tool_call_accumulators: dict[str, dict[str, Any]] = {}
        # Finalized OpenAI-chat tool_call dicts for the CURRENT turn, in arrival
        # order. Cleared at the start of each call() so calls never leak across
        # turns (mirrors the transcript-state reset in _drain_agent_response).
        # Shape per entry:
        #   {"id": call_id, "type": "function",
        #    "function": {"name": name, "arguments": <json-str>}}
        self._completed_tool_calls: List[dict[str, Any]] = []

    @property
    def url(self) -> str:
        return REALTIME_URL_TEMPLATE.format(model=self.model)

    @property
    def brokered(self) -> bool:
        """Whether the live session was minted by a gateway, not the vendor.

        Only true after ``connect()``, and only when the mint answered with
        ``X-LangWatch-Session-Id``. Configuration cannot set it, because the
        response is the one thing that cannot be told a lie about what
        answered.
        """
        return self._broker_session_id != ""

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

    # ------------------------------------------------------------- tool calls
    # Issue #630: surface OpenAI Realtime function-call events as OpenAI-chat
    # tool_calls on the assistant message in result.messages. The Realtime wire
    # describes ONE logical call across several events
    # (`response.function_call_arguments.delta` × N → `.done`, and/or
    # `response.output_item.added`/`.done` carrying the function_call item).
    # We accumulate per call_id, then finalize into self._completed_tool_calls,
    # de-duplicating so each call_id yields exactly one tool_call (AC6).

    def _accumulate_tool_call_delta(self, call_id: str, delta: str) -> None:
        """Append a streaming arguments fragment for ``call_id``."""
        acc = self._tool_call_accumulators.setdefault(
            call_id, {"name": None, "arguments": ""}
        )
        acc["arguments"] = (acc["arguments"] or "") + (delta or "")

    def _note_tool_call_name(self, call_id: str, name: Optional[str]) -> None:
        """Record the function name for ``call_id`` (the item/added event)."""
        if not name:
            return
        acc = self._tool_call_accumulators.setdefault(
            call_id, {"name": None, "arguments": ""}
        )
        acc["name"] = name

    def _finalize_tool_call(
        self,
        call_id: Optional[str],
        *,
        name: Optional[str] = None,
        arguments: Optional[str] = None,
    ) -> None:
        """Resolve one logical function call into ``self._completed_tool_calls``.

        Idempotent on ``call_id`` (AC6): the streaming-args path and the
        output-item path both describe the SAME call, so a second finalize for
        an already-completed ``call_id`` MERGES (fills a missing name / upgrades
        to a more complete arguments string) rather than appending a duplicate.

        Degrades safely (AC7): a finalize with NO ``call_id`` is skipped with a
        DEBUG log and emits nothing. Missing arguments become ``"{}"``; a
        malformed (non-JSON) arguments string is passed through verbatim — the
        adapter never parses-and-reraises.
        """
        if not call_id:
            logger.debug(
                "OpenAIRealtimeAgentAdapter: function-call event with no "
                "call_id; skipping (AC7 degraded path)"
            )
            return

        acc = self._tool_call_accumulators.get(call_id, {})
        resolved_name = name or acc.get("name")
        # Pick the most complete arguments source: explicit (item/done) arg if
        # non-empty, else the accumulated streaming deltas, else "{}".
        candidates = [arguments, acc.get("arguments")]
        resolved_args = next(
            (c for c in candidates if c is not None and c != ""), None
        )
        if resolved_args is None:
            resolved_args = "{}"

        # De-dup / merge on call_id (AC6).
        for existing in self._completed_tool_calls:
            if existing["id"] == call_id:
                fn = existing["function"]
                if not fn.get("name") and resolved_name:
                    fn["name"] = resolved_name
                # Upgrade to a longer/more-complete arguments string if the new
                # source carries more (item arguments arriving after deltas).
                if resolved_args not in ("", "{}") and len(resolved_args) > len(
                    fn.get("arguments") or ""
                ):
                    fn["arguments"] = resolved_args
                return

        self._completed_tool_calls.append(
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": resolved_name or "",
                    "arguments": resolved_args,
                },
            }
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

        # Issue #662 / reconnect hygiene (JS parity — openai-realtime.ts connect()):
        # a reused adapter instance must start each connection with a clean slate.
        # Clearing _response_active matters most: a disconnect mid-response would
        # otherwise leave it True, and the next turn's user-audio commit would take
        # the defer branch forever (no response.done ever arrives to fire it), draining
        # recv_audio to timeout.
        self._response_active = False
        self._deferred_response_create = False

        self._broker_session_id = ""
        self._session_usage = None

        # The socket's bearer is the ephemeral secret the mint returned: a
        # credential for exactly this call, so no long-lived key reaches the
        # socket. Whether OpenAI or a gateway answers the mint is a property
        # of OPENAI_BASE_URL, not of this adapter.
        socket_key = self._api_key
        if self._mint is not None:
            result = await mint_openai_realtime_session(self._mint, self.model)
            if result.minted:
                socket_key = result.credential
                self._broker_session_id = result.session_id
            else:
                # No mint route: a plain proxy, or a gateway older than this
                # feature. Dial the vendor directly, and say so, because an
                # unbilled session otherwise looks identical to a billed one.
                # A refusal never reaches here: it raises inside the mint.
                warn_direct_dial_fallback(
                    self._mint.base_url, REALTIME_MINT_PATH, self._api_key_source
                )
        if socket_key == self._api_key and not self._api_key:
            raise RuntimeError(
                "OpenAIRealtimeAgentAdapter: no API key. Set OPENAI_API_KEY or "
                "pass `api_key=` to the constructor."
            )

        try:
            self._ws = await websockets.connect(
                self.url,
                additional_headers={
                    "Authorization": f"Bearer {socket_key}",
                },
            )
        except BaseException:
            # The mint booked a session and the socket never opened, so
            # nothing will ever report against it. Closing it at zero is the
            # truth: an ephemeral secret that opened no socket used nothing.
            # Leaving it open would hold one of the key's session slots until
            # the gateway's own window expires, and book a call that never
            # happened.
            await self._close_unused_session()
            raise
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

        # Stamp realtime-specific attrs onto the active ``voice.adapter.connect``
        # span (opened by the executor connect loop). Base spans are name-owned;
        # the adapter contributes attributes, never a parallel span name (mirrors
        # ElevenLabs stamping ``voice.elevenlabs.agent_id``).
        from opentelemetry import trace as _otel_trace
        from .._telemetry import set_span_attributes

        set_span_attributes(
            _otel_trace.get_current_span(),
            {
                "voice.realtime.model": self.model,
                "voice.realtime.voice": self.voice,
                "voice.realtime.session_type": "realtime",
                "voice.realtime.tool_count": len(self.tools),
                "voice.realtime.brokered": self.brokered,
                "voice.realtime.session_id": self._broker_session_id or None,
            },
        )

    def _capture_usage(self, event: dict[str, Any]) -> None:
        """Add the usage OpenAI reports on ``response.done`` to the session.

        Read from every inbound event rather than from the audio branch,
        because a drain that ends on tail silence never reaches the terminal
        event and a session whose usage was never captured bills as
        cost-unknown.

        Summed rather than replaced. OpenAI reports usage per response, so a
        session that kept only the last ``response.done`` would bill for its
        last turn and nothing else.
        """
        if not self._broker_session_id:
            return
        if event.get("type") != "response.done":
            return
        response = event.get("response")
        if not isinstance(response, dict):
            return
        usage = response.get("usage")
        if isinstance(usage, dict):
            self._session_usage = accumulate_realtime_usage(
                self._session_usage, usage
            )

    async def _close_unused_session(self) -> None:
        """Close a session whose socket never opened.

        The mint booked it, so only a report can close it; there is no
        cancel. Zero is the correct number, not a placeholder: an ephemeral
        credential that opened no socket consumed nothing at the vendor.
        """
        if self._mint is None or not self._broker_session_id:
            return
        session_id = self._broker_session_id
        self._broker_session_id = ""
        error = await close_unused_realtime_session(self._mint, session_id)
        if error is not None:
            logger.debug(
                "OpenAIRealtimeAgentAdapter: unused-session close failed: %r",
                error,
            )

    async def _report_usage(self) -> None:
        """Close the session's spend record with what the socket measured.

        Clearing the captured usage first is what makes a second disconnect a
        no-op, so a session cannot be reported twice.
        """
        if (
            self._mint is None
            or not self._broker_session_id
            or not self._session_usage
        ):
            return
        usage = self._session_usage
        session_id = self._broker_session_id
        self._session_usage = None
        error = await report_openai_realtime_usage(self._mint, session_id, usage)
        if error is not None:
            logger.debug(
                "OpenAIRealtimeAgentAdapter: usage report failed: %r", error
            )

    async def disconnect(self) -> None:
        """Close the WebSocket if open, then close the session's spend record."""
        await self._report_usage()
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
            # Issue #662 / reconnect hygiene (JS parity): clear response-lifecycle
            # guard state on teardown so a reused adapter instance does not carry a
            # stale active/deferred flag into its next connection.
            self._response_active = False
            self._deferred_response_create = False
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

        # R2 markers/attrs land on the active ``voice.audio.receive`` span (opened
        # by the base drain that invokes recv_audio) via the ambient OTel context —
        # this method runs INSIDE that span. ``get_current_span().add_event`` is a
        # safe no-op on a non-recording span, so no extra guard is needed.
        from opentelemetry import trace as _otel_trace
        from .._telemetry import set_span_attributes

        # If send_audio was called since last recv, commit and request response.
        if self._pending_audio_bytes > 0:
            await self._ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            self._pending_audio_bytes = 0
            self._agent_turn_pending = False  # user spoke → per-turn signal consumed (always)
            if self._response_active:
                # Race guard (#657): server rejects/ignores a duplicate
                # response.create while a response is in flight, which causes the
                # recv loop to drain to timeout instead of completing.  Defer via
                # _deferred_response_create (distinct from _agent_turn_pending) so
                # the response.done handler fires response.create once the in-flight
                # response clears.
                self._deferred_response_create = True
            else:
                await self._ws.send(json.dumps({"type": "response.create"}))

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
            # Every inbound event passes here, which is why the usage capture
            # lives here and not in the terminal branch below.
            self._capture_usage(event)

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
                # R2 marker: record the response start on the active receive span.
                _otel_trace.get_current_span().add_event(
                    "voice.realtime.response.created"
                )

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
                # R2 markers: record the response terminal as a span event and
                # stamp the FINAL tool-call count onto the active
                # ``voice.audio.receive`` span. Done BEFORE the deferred re-fire and
                # the tool-only empty-chunk return below, so the count reflects THIS
                # response — set even when 0, for every response.done/.cancelled
                # actually observed. A drain that ends on tail-silence before a
                # terminal event is processed won't stamp it (pre-existing drain
                # timing, not new here).
                _otel_trace.get_current_span().add_event(f"voice.realtime.{etype}")
                set_span_attributes(
                    _otel_trace.get_current_span(),
                    {"voice.realtime.tool_call_count": len(self._completed_tool_calls)},
                )
                # Issue #657: if user audio was committed while a response was
                # in flight, _deferred_response_create was set as a deferral flag.
                # Now that _response_active is cleared, fire the deferred create.
                if self._deferred_response_create:
                    await self._ws.send(json.dumps({"type": "response.create"}))
                    self._deferred_response_create = False
                    self._response_active = True
                # Issue #646: a tool-only turn (function call, NO audio delta) would
                # otherwise loop here to the deadline and raise — the accumulated tool
                # call is parsed but never returned. When the response is done and at
                # least one tool call has been finalized this turn, return an empty
                # chunk so the drain exits cleanly and call() surfaces the tool_calls
                # message. A genuinely empty turn (done + EMPTY accumulator) must still
                # fall through to the timeout — the non-empty accumulator is the
                # discriminator, NOT response.done alone.
                # (Distinct from the drain-re-entry empty-chunk path above at the
                # _response_ever_active guard, which handles a COMPLETED prior response.)
                if self._completed_tool_calls:
                    return AudioChunk(data=b"")

            elif etype == "conversation.item.input_audio_transcription.completed":
                # User-side transcript from Whisper.
                self.last_user_transcript = event.get("transcript", "")

            elif etype == "response.function_call_arguments.delta":
                # Issue #630: streaming arguments fragment for a function call.
                # Accumulate per call_id; the call is finalized on `.done` or
                # the function_call output-item event.
                self._accumulate_tool_call_delta(
                    event.get("call_id", ""), event.get("delta", "")
                )

            elif etype == "response.function_call_arguments.done":
                # Issue #630: streaming-args path complete. `name` is typically
                # NOT on this event (it arrives via the output_item), so resolve
                # it from the accumulator. A missing call_id degrades safely.
                self._finalize_tool_call(
                    event.get("call_id"),
                    name=event.get("name"),
                    arguments=event.get("arguments"),
                )

            elif etype in ("response.output_item.added", "response.output_item.done"):
                # Issue #630: the output-item form of a function call carries the
                # authoritative `name` + `call_id` (and, on `.done`, the full
                # `arguments`). For non-function items (e.g. an audio message
                # item) this is benign housekeeping — fall through silently.
                item = event.get("item") or {}
                if isinstance(item, dict) and item.get("type") == "function_call":
                    call_id = item.get("call_id")
                    name = item.get("name")
                    if etype == "response.output_item.added":
                        # Shell arrives before args stream — record the name so a
                        # later delta/done can attach to it. Do not finalize yet.
                        self._note_tool_call_name(call_id or "", name)
                    else:
                        # `.done`: authoritative full call. Finalize (idempotent
                        # on call_id — merges with any streaming-args entry, AC6).
                        self._finalize_tool_call(
                            call_id, name=name, arguments=item.get("arguments")
                        )
                else:
                    logger.debug(
                        "OpenAIRealtimeAgentAdapter: ignoring non-function "
                        "output_item event %r",
                        etype,
                    )

            elif etype == "error":
                error_detail = event.get("error", {})
                msg = error_detail.get("message", str(error_detail))
                raise RuntimeError(
                    f"OpenAIRealtimeAgentAdapter: server error — {msg}"
                )

            else:
                # Housekeeping events — session.created, session.updated, etc. —
                # are benign. Log at DEBUG and keep the loop running.
                logger.debug(
                    "OpenAIRealtimeAgentAdapter: ignoring event type %r", etype
                )

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """Surface realtime tool calls alongside the spoken audio turn (#630).

        The base ``call()`` returns a single assistant audio message and does
        all the recording bookkeeping. We keep that intact and, when the agent
        called any tools this turn, append ONE extra assistant message carrying
        every tool call as OpenAI-chat ``tool_calls`` — the shape
        ``state.has_tool_call`` / ``state.last_tool_call`` consume.

        Returns:
            - the single audio message (dict) when no tools were called — byte
              identical to the base behaviour (AC8 regression), OR
            - ``[audio_message, tool_call_message]`` when ≥1 tool was called
              (AC1/AC9/AC10). ``convert_agent_return_types_to_openai_messages``
              passes a list of dicts through verbatim into result.messages.

        The completed-calls list is reset HERE (turn start) so tool calls never
        leak across turns; the function-call events for THIS turn are consumed
        inside the ``super().call()`` drain and finalized onto the list.
        """
        # Reset per-turn tool-call state so a prior turn's calls don't bleed
        # through (mirrors the transcript reset in _drain_agent_response).
        self._deferred_response_create = False
        self._completed_tool_calls = []
        self._tool_call_accumulators = {}

        audio_message = await super().call(input)

        if not self._completed_tool_calls:
            return audio_message

        # One assistant message carrying ALL of this turn's tool calls — the
        # conventional OpenAI shape (one assistant turn, many tool_calls).
        tool_call_message: ChatCompletionMessageParam = cast(
            ChatCompletionMessageParam,
            {
                "role": "assistant",
                "content": None,
                "tool_calls": list(self._completed_tool_calls),
            },
        )
        return [cast(ChatCompletionMessageParam, audio_message), tool_call_message]

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
        # Guard: if a response is already in flight, defer the create rather than
        # firing unconditionally — mirrors the recv_audio user-audio branch guard.
        if self._response_active:
            self._deferred_response_create = True
            return
        await self._ws.send(json.dumps({"type": "response.create"}))
        logger.debug(
            "OpenAIRealtimeAgentAdapter: send_text injected text (%d chars)", len(text)
        )
