"""
TwilioAgentAdapter: bidirectional real phone transport via Twilio Media Streams.

One adapter class serves both directions a Twilio number can participate in:

- **Inbound** — ``wait_for_call()`` sets the number's voice webhook to our
  local server, blocks until a caller dials in, and opens a Media Streams
  WebSocket for the call.
- **Outbound** — ``place_call(to=...)`` originates a call via Twilio REST,
  then accepts the Media Streams WebSocket Twilio opens back to us.

``connect()`` is direction-agnostic: resolve the number SID, start a
FastAPI webhook + Media Streams WS server, open a public URL (user-supplied
or via ``CloudflareTunnel``). After ``connect()``, call either
``place_call()`` or ``wait_for_call()``.

See source §5.3 and docs/proposals/issue-350-ralph-real-transports.md.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import Any, Callable, ClassVar, Literal, Optional

# The adapter is dormant after connect() and before a direction-specific kickoff
# method is called. Mode is dynamic — we don't take it at construction — because
# the same credentials + tunnel can serve either direction, and picking at
# first-use keeps the API small.
TwilioAdapterMode = Literal["idle", "answer", "call"]

from ...types import AgentRole
from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities
from ._twilio_shared import (
    TWILIO_FRAME_MS,
    TwilioRESTHelper,
    _redact_e164,
    build_clear_frame,
    build_media_frame,
    iter_mulaw_frames,
    pcm16_24k_to_mulaw8k,
    validate_e164,
)


logger = logging.getLogger("scenario.voice.twilio")


#: A-leg <Say> anchor for outbound calls. Whisper hallucinates non-English
#: text on bare ``<Pause>`` silence (#465 in this PR), so we play one known-
#: good utterance at call setup, then hold the line for the Media Stream to
#: carry the real bidirectional conversation.
PLACE_CALL_A_LEG_SAY_TEXT = (
    "Thank you for calling. "
    "I will hold the line while you complete your scenario."
)


class TwilioAgentAdapter(VoiceAgentAdapter):
    """
    Bidirectional Twilio Media Streams adapter.

    Same class, same state, either direction:

        adapter = TwilioAgentAdapter(
            account_sid=..., auth_token=...,
            phone_number="+14155551234",
        )
        async with adapter:                   # connect() / disconnect()
            await adapter.place_call(to="+14155557777")  # OR wait_for_call()
            # ... scenario.run(...) feeds send_audio / recv_audio ...

    The adapter is the *only* adapter with ``dtmf=True``. DTMF events
    received from the callee surface via the ``on_dtmf`` callback set at
    construction time. To send DTMF, use ``send_dtmf()``.

    ``interrupt(after_words=N)`` raises ``UnsupportedCapabilityError`` on this
    adapter — Media Streams delivers raw audio without incremental
    transcripts. Use ``interrupt(after=seconds)`` instead.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=False,
        native_vad=False,
        dtmf=True,
        # Twilio Media Streams ``clear`` event drops all buffered outbound
        # audio. Used by ``adapter.interrupt()`` already wired below.
        interruption=True,
        input_formats=["mulaw/8000"],
        output_formats=["mulaw/8000"],
    )

    # ------------------------------------------------------------------ init

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        phone_number: str,
        public_base_url: Optional[str] = None,
        allowed_callers: Optional[list[str]] = None,
        on_dtmf: Optional[Callable[[str], None]] = None,
        http_port: int = 8765,
        role: AgentRole = AgentRole.AGENT,
        validate_signature: bool = True,
    ) -> None:
        super().__init__()
        validate_e164(phone_number)

        self.account_sid = account_sid
        self.auth_token = auth_token
        self.phone_number = phone_number
        self.public_base_url = public_base_url
        self.allowed_callers = set(allowed_callers) if allowed_callers else None
        self.on_dtmf = on_dtmf
        self.http_port = http_port
        self.role = role  # type: ignore[misc]
        # When True (default), the inbound /twilio/voice route requires a
        # valid X-Twilio-Signature header before accepting the webhook
        # body. The cloudflared tunnel URL is ephemeral and not
        # guessable, but anyone who learns it could otherwise POST fake
        # Twilio webhook events into the harness. Tests that don't have
        # real Twilio credentials disable this with
        # ``validate_signature=False``; production callers should leave
        # it on.
        self.validate_signature = validate_signature
        if not validate_signature:
            logger.warning(
                "TwilioAgentAdapter: validate_signature=False — inbound "
                "webhooks accept any payload without signature checks. "
                "Use only in tests; do not deploy to production."
            )

        # Populated during connect(); None when disconnected.
        self._rest: Optional[TwilioRESTHelper] = None
        self._phone_number_sid: Optional[str] = None
        self._prior_voice_url: Optional[str] = None
        # Set by place_call() when it rewrites the callee's voice_url so
        # B-leg's webhook lands on our harness. Restored in disconnect.
        self._callee_phone_number_sid: Optional[str] = None
        self._prior_callee_voice_url: Optional[str] = None
        # Set by the first of wait_for_call()/place_call(); subsequent calls to
        # the other method raise. "idle" after connect() before either fires.
        self._mode: TwilioAdapterMode = "idle"

        # Server / media stream state.
        self._server_task: Optional[asyncio.Task] = None
        self._server_shutdown: Optional[asyncio.Event] = None
        self._call_sid: Optional[str] = None
        self._stream_sid: Optional[str] = None
        self._stream_connected: Optional[asyncio.Event] = None
        self._stream_ws: Any = None  # starlette WebSocket
        self._inbound_queue: Optional[asyncio.Queue[AudioChunk]] = None


    # ------------------------------------------------------------------ repr

    def __repr__(self) -> str:  # redact credentials
        return (
            f"TwilioAgentAdapter("
            f"phone_number={self.phone_number!r}, "
            f"account_sid='***', auth_token='***', "
            f"public_base_url={self.public_base_url!r})"
        )

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Resolve number SID and start the FastAPI webhook + WS server.

        Does NOT modify the Twilio account's ``voice_url``. That side-effect
        only happens when ``wait_for_call()`` is invoked — callers (who will
        use ``place_call()``) never overwrite their number's inbound webhook,
        which makes caller-mode adapters safe to run against a shared pool of
        Twilio numbers without clobbering anyone's prod webhook.

        Idempotent: calling connect() on an already-connected adapter is a
        no-op. This lets the scenario executor's auto-connect step
        (``_voice_connect_all``) coexist with explicit harness-driven
        connects (``TwilioHarness`` ``__aenter__``) that already brought
        the adapter up before scenario.run() was called.
        """
        if self._rest is not None:
            return

        if self.public_base_url is None:
            raise RuntimeError(
                "TwilioAgentAdapter: public_base_url is required. Wrap the "
                "adapter in scenario.voice.testing.TwilioHarness, or supply "
                "a stable public HTTPS URL that routes to this machine."
            )

        self._rest = TwilioRESTHelper(self.account_sid, self.auth_token)
        self._phone_number_sid = self._rest.resolve_phone_number_sid(self.phone_number)

        self._stream_connected = asyncio.Event()
        self._inbound_queue = asyncio.Queue()
        self._server_shutdown = asyncio.Event()
        self._mode = "idle"

        # Webhook server is its own unit — see _twilio_server.py. The
        # adapter only orchestrates lifecycle; the routes, signature
        # validation, and WS framing live in TwilioWebhookServer.
        from ._twilio_server import TwilioWebhookServer
        self._webhook_server: Optional[TwilioWebhookServer] = TwilioWebhookServer(self)
        self._server_task = asyncio.create_task(self._run_server())
        # Give uvicorn a beat to bind the port before Twilio hits it.
        await asyncio.sleep(0.2)

    async def disconnect(self) -> None:
        """Restore prior voice_url (answer mode only), tear down server.

        Best-effort on errors. In caller mode we never touched the Twilio
        number's voice_url, so there's nothing to restore.
        """
        if self._rest is None:
            return

        # 1. Restore webhook first so Twilio doesn't keep hitting a dead URL.
        if self._mode == "answer" and self._phone_number_sid is not None:
            with suppress(Exception):
                prior = self._prior_voice_url or ""
                self._rest.write_voice_url(self._phone_number_sid, prior)
                logger.debug(
                    "TwilioAgentAdapter: restored voice_url=%r on %s",
                    prior,
                    self._phone_number_sid,
                )
        # place_call() rewrites the CALLEE's voice_url to attach Media
        # Streams to B-leg. Restore that too.
        if self._mode == "call" and self._callee_phone_number_sid is not None:
            with suppress(Exception):
                prior_b = self._prior_callee_voice_url or ""
                self._rest.write_voice_url(self._callee_phone_number_sid, prior_b)
                logger.debug(
                    "TwilioAgentAdapter: restored callee voice_url=%r on %s",
                    prior_b,
                    self._callee_phone_number_sid,
                )

        # 2. Signal server to shut down, then wait for the task.
        if self._server_shutdown is not None:
            self._server_shutdown.set()
        if self._server_task is not None:
            with suppress(Exception):
                await asyncio.wait_for(self._server_task, timeout=3.0)

        # 3. Reset state.
        self._rest = None
        self._phone_number_sid = None
        self._prior_voice_url = None
        self._callee_phone_number_sid = None
        self._prior_callee_voice_url = None
        self._mode = "idle"
        self._server_task = None
        self._server_shutdown = None
        self._call_sid = None
        self._stream_sid = None
        self._stream_connected = None
        self._stream_ws = None
        self._inbound_queue = None

    # ------------------------------------------------------------------ direction

    async def place_call(
        self,
        to: str,
        *,
        timeout: float = 120.0,
        attach_stream_to_self: bool = True,
    ) -> None:
        """
        Originate an outbound call from this adapter's Twilio number to ``to``.

        Twilio's REST ``Calls.create`` runs TwiML on TWO legs of the
        resulting call:

        - **A-leg** (the originator, ``from_=self.phone_number``): runs the
          inline TwiML passed via ``twiml=`` to ``Calls.create``. We use
          ``<Pause length=120>`` so the originator just holds the bridge
          open while the demo runs.
        - **B-leg** (the callee, ``to=``): when Twilio dials B and B picks
          up, B's number's ``voice_url`` fires — that's where the bridge's
          Media Streams attach. This is identical to the inbound demo's
          flow: B's voice_url returns ``<Connect><Stream>``, the WS opens,
          audio flows.

        So ``place_call`` only makes sense when ``to`` is another Twilio
        number on this account whose ``voice_url`` is set to OUR harness
        webhook. To make that wiring automatic, ``place_call`` temporarily
        rewrites B's ``voice_url`` for the duration of the call and
        restores it on ``disconnect``. The harness on this adapter's own
        number does NOT need to be answer-mode — the Stream attaches to
        B's leg, NOT this adapter's leg, but B's webhook is hosted on this
        adapter's local server, so the WS still lands here.

        The bidirectional audio model is unchanged: ``send_audio`` writes
        frames over the WS (B hears them and bridges to A), ``recv_audio``
        reads inbound frames off the WS (whatever the bridge mixes from
        both legs).

        Limitation: ``to`` MUST be a phone number on this same Twilio
        account. Calling an external PSTN endpoint (a real cell phone)
        requires a different topology (``<Start><Stream>`` + ``<Dial>``)
        which we don't implement here because the inline TwiML route on
        the A-leg can't capture B's audio when B is external.

        Default timeout 120s covers cloudflared cold-start latency.

        Raises:
            RuntimeError: If called after ``wait_for_call()`` (modes are
                exclusive per adapter instance), or if ``to`` is not a
                Twilio number on this account.
            ValueError: If ``to`` is not in E.164 format.
            asyncio.TimeoutError: If the media stream doesn't open within
                ``timeout`` seconds.
        """
        self._assert_connected()
        self._enter_mode("call")
        validate_e164(to)

        assert self.public_base_url is not None
        assert self._rest is not None
        assert self._stream_connected is not None

        if attach_stream_to_self:
            # Resolve B-leg's number SID and snapshot+rewrite its voice_url so
            # B's leg attaches its Media Stream to our harness webhook. We own
            # this number (same Twilio account); disconnect() will restore.
            self._callee_phone_number_sid = self._rest.resolve_phone_number_sid(to)
            self._prior_callee_voice_url = self._rest.read_voice_url(
                self._callee_phone_number_sid
            )
            webhook_url = self.public_base_url.rstrip("/") + "/twilio/voice"
            self._rest.write_voice_url(self._callee_phone_number_sid, webhook_url)
            logger.info(
                "TwilioAgentAdapter: rewrote callee %s voice_url to %s",
                _redact_e164(to),
                webhook_url,
            )

        # A-leg TwiML: play a short deterministic <Say> line, then hold
        # the bridge open. Twilio runs this on the originator side while
        # B's webhook attaches the Media Stream.
        #
        # The <Say> gives the recording a known-good utterance to
        # transcribe. A bare <Pause> alone produces 120s of line silence
        # that Whisper has been observed to hallucinate as non-English
        # text (issue #465 in this PR). The Say is a one-time anchor at
        # call setup; the Media Stream carries the real bidirectional
        # conversation that follows.
        inline_a_leg_twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Say voice="Polly.Joanna">{PLACE_CALL_A_LEG_SAY_TEXT}</Say>'
            '<Pause length="120"/>'
            "</Response>"
        )
        self._call_sid = self._rest.place_call(
            to=to, from_=self.phone_number, twiml=inline_a_leg_twiml
        )
        logger.info(
            "TwilioAgentAdapter: placed call %s from %s to %s",
            self._call_sid,
            _redact_e164(self.phone_number),
            _redact_e164(to),
        )

        if attach_stream_to_self:
            # Wait for OUR webhook to fire — only meaningful when we rewrote
            # the callee's voice_url to point at us. In originator-only mode
            # (attach_stream_to_self=False), there's no stream coming to us;
            # the callee has its own harness which owns the stream.
            await asyncio.wait_for(self._stream_connected.wait(), timeout=timeout)

    async def wait_for_call(self, timeout: float = 120.0) -> None:
        """
        Block until someone dials in and the media stream is live.

        In **default mode** (no conference_room): the number's ``voice_url``
        is overwritten to point at our webhook so inbound calls reach us.
        Caller (``place_call``) elsewhere will dial this number.

        In **conference mode**: there's no inbound call to wait for — the
        two-Twilio-number demo can't naturally have one side receive an
        inbound call when both legs need conference TwiML. Instead, we
        ORIGINATE an outbound call FROM this adapter's number TO itself
        with inline TwiML that opens the capture stream and dials into
        the shared conference room. This is the symmetric counterpart to
        ``place_call`` in conference mode — both adapters end up as
        participants in the same room, exchanging audio via the bridge.

        Default timeout 120s covers cloudflared cold-start, conference-room
        formation, and Twilio's webhook ramp.

        Raises:
            RuntimeError: If called after ``place_call()``.
            asyncio.TimeoutError: If nobody dials in within ``timeout``.
        """
        self._assert_connected()
        self._enter_mode("answer")

        assert self.public_base_url is not None
        assert self._rest is not None
        assert self._phone_number_sid is not None
        assert self._stream_connected is not None

        # Snapshot the prior webhook so we can restore it on disconnect, then
        # point the number at our server. Only answer mode does this.
        self._prior_voice_url = self._rest.read_voice_url(self._phone_number_sid)
        webhook_url = self.public_base_url.rstrip("/") + "/twilio/voice"
        self._rest.write_voice_url(self._phone_number_sid, webhook_url)
        logger.info("TwilioAgentAdapter: webhook set to %s", webhook_url)

        await asyncio.wait_for(self._stream_connected.wait(), timeout=timeout)

    def _enter_mode(self, mode: TwilioAdapterMode) -> None:
        """Transition idle → mode, or raise if already in a different mode.

        Modes are exclusive per connected session: an adapter can place a call
        or answer a call, not both. Disconnect + reconnect to reuse the
        instance in the other direction.
        """
        if self._mode == mode:
            return  # idempotent re-entry (e.g. retrying place_call after timeout)
        if self._mode != "idle":
            raise RuntimeError(
                f"TwilioAgentAdapter: already in {self._mode!r} mode; cannot "
                f"switch to {mode!r}. Disconnect and reconnect to reuse this "
                f"adapter in the other direction."
            )
        self._mode = mode

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        # Pace at real-time (one frame per TWILIO_FRAME_MS). Without pacing the
        # whole utterance arrives in milliseconds, which trips bots' VAD into
        # a clipped-utterance reading.
        self._assert_stream_live()

        ws = self._stream_ws
        stream_sid = self._stream_sid
        assert ws is not None and stream_sid is not None

        mulaw = pcm16_24k_to_mulaw8k(chunk.data)
        frame_secs = TWILIO_FRAME_MS / 1000
        for frame in iter_mulaw_frames(mulaw):
            if not frame:
                continue
            await ws.send_text(build_media_frame(stream_sid, frame))
            await asyncio.sleep(frame_secs)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        self._assert_stream_live()
        assert self._inbound_queue is not None
        return await asyncio.wait_for(self._inbound_queue.get(), timeout=timeout)

    async def send_dtmf(self, tones: str) -> None:
        """Send DTMF digits on the live call (uses Twilio REST ``<Play digits>``)."""
        if self._rest is None or self._call_sid is None:
            raise RuntimeError("TwilioAgentAdapter: no active call; send_dtmf requires an in-progress call")
        # Run blocking REST call off-thread so we don't stall the event loop.
        await asyncio.to_thread(self._rest.send_dtmf_on_call, self._call_sid, tones)

    async def interrupt(self) -> None:
        """Drop any buffered outbound audio on Twilio's side (``clear`` event)."""
        self._assert_stream_live()
        ws = self._stream_ws
        stream_sid = self._stream_sid
        assert ws is not None and stream_sid is not None
        await ws.send_text(build_clear_frame(stream_sid))

    # ------------------------------------------------------------------ server

    async def _run_server(self) -> None:
        """Thin lifecycle wrapper; the real work lives in TwilioWebhookServer."""
        assert self._webhook_server is not None
        await self._webhook_server.run()

    def _build_app(self) -> Any:
        """Test seam: build the FastAPI app for in-process exercise.

        Production code never calls this — the server's ``run()`` builds
        the app itself when uvicorn starts. Existing unit tests use
        ``TestClient(_build_app())`` to exercise the routes without
        binding a port; the delegation keeps that test surface stable.
        """
        assert self._webhook_server is not None
        return self._webhook_server.build_app()

    async def _media_stream_loop(self, ws: Any) -> None:
        """Test seam: kick off the Media Streams WS loop directly.

        The two-adapter-bridge test in
        ``tests/voice/test_twilio_two_adapter_bridge.py`` uses this to
        drive a loopback WS without going through the FastAPI route
        wrapper. Production code reaches the loop via the ``/twilio/stream``
        WebSocket handler defined in ``_twilio_server.build_app``.
        """
        assert self._webhook_server is not None
        await self._webhook_server.media_stream_loop(ws)

    # ------------------------------------------------------------------ assertions

    def _assert_connected(self) -> None:
        if self._rest is None:
            raise RuntimeError("TwilioAgentAdapter: not connected; call connect() or use `async with`.")

    def _assert_stream_live(self) -> None:
        self._assert_connected()
        if self._stream_ws is None or self._stream_sid is None:
            raise RuntimeError(
                "TwilioAgentAdapter: no live media stream. Call place_call() or "
                "wait_for_call() first."
            )
