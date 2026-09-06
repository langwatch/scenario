"""
PipecatAgentAdapter: WebSocket client to a user-run Pipecat bot.

Source §5.1. Pipecat is a framework for BUILDING voice agents. The user
runs their Pipecat bot separately (e.g. ``python bot.py -t twilio --port 8765``)
and this adapter connects as a client to exchange audio with it.

**Wire protocol.** A pipecat bot configured with the ``-t twilio`` transport
uses ``TwilioFrameSerializer`` on its WebSocket — the same Twilio Media
Streams JSON protocol scenario's ``TwilioAgentAdapter`` already speaks.
Scenario impersonates Twilio: sends a synthetic ``start`` event with fake
stream/call SIDs, then exchanges ``media`` events carrying base64-encoded
µ-law 8kHz audio.

``transport="webrtc"`` (SmallWebRTC) is not implemented in this PR — it
stays on ``PendingTransportError`` and is tracked in a follow-up issue.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, ClassVar, Literal, Optional

from opentelemetry.context import Context

from ..adapter import AgentStreamEndedError, VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities
from .._telemetry import voice_span
from ._twilio_shared import (
    TWILIO_FRAME_MS,
    build_clear_frame,
    build_mark_frame,
    build_media_frame,
    iter_mulaw_frames,
    mulaw8k_to_pcm16_24k,
    parse_media_stream_frame,
    pcm16_24k_to_mulaw8k,
)


logger = logging.getLogger("scenario.voice.pipecat")


_RECV_LOOP_DONE = object()
"""Sentinel pushed onto the inbound queue when _recv_loop terminates, so a
waiting recv_audio wakes immediately and surfaces the terminal cause instead of
blocking until its caller's timeout fires on a queue nothing will fill (#498)."""


class PipecatRecvError(AgentStreamEndedError):
    """recv_audio could get no audio because the background _recv_loop ended.

    Names the real reason — a crash in the read loop (decode/transport error,
    chained via __cause__) or a clean WebSocket close by the bot — so the #498
    2nd-turn hang surfaces an attributable error instead of a blind
    response_timeout with an empty body.
    """


class PipecatAgentAdapter(VoiceAgentAdapter):
    """
    Test a running Pipecat bot via its exposed WebSocket endpoint.

    Transport is selected by the ``transport`` argument:
        - ``"websocket"`` (default): Twilio Media Streams protocol over WS.
          Scenario sends a synthetic ``start`` event, then ``media`` frames.
          Pipecat's ``TwilioFrameSerializer`` on the bot side handles the
          wire format.
        - ``"webrtc"``: SmallWebRTC-style negotiation. Raises
          ``PendingTransportError``; tracked as a follow-up.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        # The Twilio Media Streams wire protocol carries audio frames only,
        # never transcript events. Advertising streaming_transcripts made
        # interrupt(after_words=N) poll a ``streaming_transcript`` attribute
        # this adapter never populates, hanging the script step forever.
        # Turn-level transcripts come from the base call()'s runtime STT.
        streaming_transcripts=False,
        native_vad=True,
        dtmf=False,
        # Pipecat over the Twilio WS transport speaks the Twilio Media Streams
        # protocol; the ``clear`` event drops all buffered outbound audio on
        # the bot side. That's first-class interrupt — no VAD timing race.
        interruption=True,
        input_formats=["pcm16/24000", "mulaw/8000", "opus"],
        output_formats=["pcm16/24000", "mulaw/8000", "opus"],
    )

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        signaling_url: Optional[str] = None,
        transport: Literal["websocket", "webrtc"] = "websocket",
        audio_format: str = "mulaw",
        sample_rate: int = 8000,
        stream_sid: Optional[str] = None,
        call_sid: Optional[str] = None,
    ) -> None:
        super().__init__()
        if transport == "websocket" and url is None:
            raise ValueError("PipecatAgentAdapter(transport='websocket') requires url=")
        if transport == "webrtc" and signaling_url is None:
            raise ValueError("PipecatAgentAdapter(transport='webrtc') requires signaling_url=")

        self.url = url
        self.signaling_url = signaling_url
        self.transport = transport
        self.audio_format = audio_format
        self.sample_rate = sample_rate
        # Synthetic SIDs pipecat's TwilioFrameSerializer needs in the `start`
        # event. If caller doesn't supply them, we fabricate UUIDs. Pipecat
        # uses them for logging and the auto-hangup REST call; both are no-ops
        # when we're not actually going through Twilio.
        self.stream_sid = stream_sid
        self.call_sid = call_sid

        self._ws: Any = None
        self._recv_task: Optional[asyncio.Task] = None
        # Carries AudioChunks plus the _RECV_LOOP_DONE sentinel (hence Any), so a
        # waiting recv_audio learns the loop ended instead of blocking forever.
        self._inbound_queue: Optional[asyncio.Queue[Any]] = None
        # Set by _recv_loop when it crashes; recv_audio reads it to name the root
        # cause (chained via __cause__) on the PipecatRecvError it raises (#498).
        self._recv_loop_exc: Optional[BaseException] = None
        # Set True when _recv_loop terminates (crash or clean close). Lets
        # recv_audio fail fast on a drained queue without re-reading it (#498).
        self._recv_loop_done: bool = False
        # The turn context we last emitted a background ``voice.audio.receive``
        # span for — so ``_deliver`` spans only the FIRST wire delivery of each
        # turn (one span/turn, no per-100ms-chunk flood). Reset implicitly: the
        # next turn publishes a distinct ``_voice_turn_context`` object (#774).
        self._bg_span_turn_context: Optional[Context] = None
        # Serialises concurrent send_audio() calls — without it two paced
        # senders would interleave 20-ms mulaw frames on the wire and the
        # bot would receive corrupted audio. Used for the interruption case
        # where the executor calls send_audio() while a previous turn's
        # send is still in flight.
        self._send_lock: Optional[asyncio.Lock] = None

    @property
    def transport_format(self) -> str:
        return f"{self.audio_format}/{self.sample_rate}"

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        if self.transport == "webrtc":
            from ._stub import PendingTransportError

            raise PendingTransportError(
                "PipecatAgentAdapter(transport='webrtc')"
            )

        # Lazy import so `import scenario` doesn't require websockets at the
        # top of the module-load path (it's already a hard dep, but being
        # consistent with the Twilio adapter style).
        import websockets

        assert self.url is not None  # validated in __init__
        self._ws = await websockets.connect(
            self.url, ping_interval=None, ping_timeout=None
        )
        self._inbound_queue = asyncio.Queue()
        self._recv_loop_exc = None  # reset per fresh connection
        self._recv_loop_done = False
        self._send_lock = asyncio.Lock()

        # Send the synthetic `start` event that pipecat's TwilioFrameSerializer
        # requires to learn the stream/call SIDs and start deserializing
        # media frames.
        if self.stream_sid is None:
            self.stream_sid = f"MZ{uuid.uuid4().hex}"
        if self.call_sid is None:
            self.call_sid = f"CA{uuid.uuid4().hex}"

        await self._ws.send(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
        await self._ws.send(
            json.dumps(
                {
                    "event": "start",
                    "streamSid": self.stream_sid,
                    "start": {
                        "streamSid": self.stream_sid,
                        "callSid": self.call_sid,
                        "mediaFormat": {
                            "encoding": "audio/x-mulaw",
                            "sampleRate": 8000,
                            "channels": 1,
                        },
                    },
                }
            )
        )

        # Stamp Pipecat transport attrs onto the active ``voice.adapter.connect``
        # span (opened by the executor connect loop). Base spans are name-owned;
        # the adapter contributes attributes, never a parallel span name — mirror
        # ElevenLabs' ``voice.elevenlabs.agent_id`` seam (``adapters/elevenlabs.py``).
        from opentelemetry import trace as _otel_trace
        from .._telemetry import set_span_attributes

        set_span_attributes(
            _otel_trace.get_current_span(),
            {
                "voice.pipecat.transport": self.transport,
                "voice.pipecat.transport_format": self.transport_format,
            },
        )

        self._recv_task = asyncio.create_task(self._recv_loop())
        logger.debug("PipecatAgentAdapter: connected to %s (stream=%s)", self.url, self.stream_sid)

    async def disconnect(self) -> None:
        ws = self._ws
        if ws is None:
            return

        # Send `stop` event so the bot can clean up its pipeline gracefully.
        try:
            if self.stream_sid:
                await ws.send(json.dumps({"event": "stop", "streamSid": self.stream_sid}))
        except Exception:
            logger.debug("PipecatAgentAdapter: failed to send stop frame", exc_info=True)

        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                # Expected: we just cancelled it.
                pass
            except Exception:
                # Unexpected teardown error — already logging enough context
                # elsewhere; disconnect() is best-effort.
                logger.debug("PipecatAgentAdapter: recv_task raised during cancel", exc_info=True)
            self._recv_task = None

        try:
            await ws.close()
        except Exception:
            # WS may already be closed by the peer; disconnect() is best-effort.
            logger.debug("PipecatAgentAdapter: ws.close() raised", exc_info=True)

        self._ws = None
        self._inbound_queue = None
        self.stream_sid = None
        self.call_sid = None

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        # Pace at real-time (TWILIO_FRAME_MS/1000s per 20-ms frame). Matches what
        # a real caller produces over a PSTN line — the SUT sees normal speech
        # rhythm, not a synthetic dump.
        #
        # After the last frame we send a Twilio ``mark`` named "utterance_end".
        # Real-time pacing means TTS-induced inter-phrase pauses survive on the
        # wire, and a stateless inactivity-timer on the receiver can't
        # distinguish "speaker paused after a comma" from "speaker finished
        # their turn." The mark is an explicit, non-ambiguous end-of-turn
        # signal: cooperating SUTs flush on the mark; legacy SUTs fall back to
        # VAD timing.
        self._assert_connected()
        assert self._ws is not None and self.stream_sid is not None and self._send_lock is not None
        mulaw = pcm16_24k_to_mulaw8k(chunk.data)
        frame_secs = TWILIO_FRAME_MS / 1000
        async with self._send_lock:
            for frame in iter_mulaw_frames(mulaw):
                if not frame:
                    continue
                await self._ws.send(build_media_frame(self.stream_sid, frame))
                await asyncio.sleep(frame_secs)
            await self._ws.send(build_mark_frame(self.stream_sid, "utterance_end"))

    async def recv_audio(self, timeout: float) -> AudioChunk:
        self._assert_connected()
        assert self._inbound_queue is not None
        # The loop already terminated and its queue is drained → fail fast with
        # the terminal cause instead of blocking for `timeout` on a queue nothing
        # will fill. The flag + drained-queue check is the terminal state for the
        # rest of this connection (no await, no re-pushed sentinel to leak).
        if self._recv_loop_done and self._inbound_queue.empty():
            raise self._recv_loop_ended_error() from self._recv_loop_exc
        item = await asyncio.wait_for(self._inbound_queue.get(), timeout=timeout)
        if item is _RECV_LOOP_DONE:
            raise self._recv_loop_ended_error() from self._recv_loop_exc
        return item

    def _recv_loop_ended_error(self) -> PipecatRecvError:
        # Chaining is done at the raise site (``raise ... from self._recv_loop_exc``)
        # so ``__suppress_context__`` is set correctly and the clean-close branch
        # (exc is None → ``from None``) gets a true empty cause.
        exc = self._recv_loop_exc
        if exc is not None:
            return PipecatRecvError(
                "pipecat recv loop crashed; no further audio will arrive: "
                f"{type(exc).__name__}: {exc}"
            )
        return PipecatRecvError(
            "pipecat bot closed the WebSocket; no further audio will arrive — the "
            "bot hung up or its pipeline stopped without responding"
        )

    async def interrupt(self) -> None:
        """Send a Twilio ``clear`` frame — the bot drops all buffered outbound
        audio immediately. Cooperating Pipecat bots (and any code wired to
        the Media Streams protocol) treat ``clear`` as "stop talking now."
        Use this in preference to timing-based barge-in when the SUT
        supports it: it's deterministic, doesn't depend on VAD detection
        windows, and matches the same protocol used in production.
        """
        self._assert_connected()
        assert self._ws is not None and self.stream_sid is not None
        await self._ws.send(build_clear_frame(self.stream_sid))
        logger.debug("PipecatAgentAdapter: sent clear frame (interrupt)")

    # ------------------------------------------------------------------ background

    async def _recv_loop(self) -> None:
        """Read frames from pipecat, decode µ-law → PCM16 24k, enqueue."""
        assert self._ws is not None and self._inbound_queue is not None
        queue = self._inbound_queue
        buffered_mulaw = bytearray()
        BATCH_MS = 100

        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    # pipecat sometimes emits binary frames for audio; treat
                    # as raw µ-law payload if we see one.
                    buffered_mulaw.extend(raw)
                    if len(buffered_mulaw) >= (BATCH_MS * 8):
                        self._deliver(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                    continue

                frame = parse_media_stream_frame(raw)
                if frame is None:
                    continue
                if frame.event == "media" and frame.payload_mulaw:
                    buffered_mulaw.extend(frame.payload_mulaw)
                    if len(buffered_mulaw) >= (BATCH_MS * 8):
                        self._deliver(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                elif frame.event == "stop":
                    if buffered_mulaw:
                        self._deliver(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # #498: do NOT swallow. A crash here (decode error, transport reset,
            # bot pipeline failure) used to only log + fall through, leaving the
            # inbound queue silent so recv_audio blocked the full response_timeout
            # with no attributable cause. Record it; recv_audio raises
            # PipecatRecvError naming this as the root cause (chained via __cause__).
            self._recv_loop_exc = exc
            logger.warning("PipecatAgentAdapter: recv loop crashed", exc_info=True)
        finally:
            # Mark terminal, then wake any pending recv_audio: no more audio will
            # arrive on this connection. The flag lets later recv_audio calls fail
            # fast on the drained queue; the sentinel unblocks a getter currently
            # awaiting an empty queue. Together they turn an indefinite wait into
            # an immediate, attributable PipecatRecvError. (No await between the
            # two lines, so a waiter can't observe a half-set terminal state.)
            self._recv_loop_done = True
            queue.put_nowait(_RECV_LOOP_DONE)

    def _deliver(self, mulaw: bytes) -> None:
        """Decode a coalesced µ-law batch to PCM16/24k and enqueue it.

        On the FIRST wire delivery of a turn — the base ``call()`` published its
        OTel context via :attr:`VoiceAgentAdapter._voice_turn_context` — wrap the
        decode+enqueue in a ``voice.audio.receive`` span parented to THAT turn
        (#774), so the background ``_recv_loop`` task's receive work is attributed
        to the turn instead of the task's frozen connect-time context (a
        now-closed span).

        This is a producer-side **delivery marker** (it carries the delivered
        byte count); the consumer-side wait and the timeout/ERROR semantics (P3)
        live on the base ``voice.audio.receive`` span that wraps ``recv_audio``.
        The span is disambiguated from that base span by
        ``voice.pipecat.recv.source=background_loop``.

        Emitted at most ONCE per turn (only the first delivery under a given turn
        context) — matching the base's one-receive-span-per-turn granularity and
        the epic's no-per-tick-flood rule (the EL pump H1), so a multi-second turn
        of 100 ms chunks is not exploded into dozens of sibling spans. Between
        turns the context is ``None`` and we enqueue WITHOUT a span, so no
        detached/closed-parent span can leak from the background task. The body is
        synchronous (``put_nowait`` on the unbounded queue), so a ``disconnect()``
        cancel can never land mid-span.

        Coverage limits (by design — this is a marker, not exhaustive accounting):
        - ``voice.audio.bytes`` is the DELIVERED coalesced-chunk size, which may
          fold in a sub-100 ms µ-law tail carried over from the prior turn (the
          recv-loop coalesces to 800-byte batches across the turn boundary — a
          pre-existing property the base drain chunks share; not corrected here
          because flushing a partial batch at the boundary would drop that audio).
        - A turn whose agent audio was ALREADY buffered before ``call()`` published
          the turn context (an opening greeting delivered during ``connect``) is
          drained from the queue without a fresh wire delivery, so it gets no
          background marker — the base ``voice.audio.receive`` span still covers
          its consumption. The marker records in-turn wire deliveries, not every
          turn that consumes audio (the deterministic turn-liveness gate).
        """
        assert self._inbound_queue is not None
        parent = self._voice_turn_context
        if parent is None or parent is self._bg_span_turn_context:
            self._inbound_queue.put_nowait(AudioChunk(data=mulaw8k_to_pcm16_24k(mulaw)))
            return
        self._bg_span_turn_context = parent
        with voice_span(
            "voice.audio.receive",
            {
                "voice.adapter.class": type(self).__name__,
                "voice.pipecat.recv.source": "background_loop",
            },
            parent=parent,
        ) as span:
            pcm = mulaw8k_to_pcm16_24k(mulaw)
            span.set_attribute("voice.audio.bytes", len(pcm))
            self._inbound_queue.put_nowait(AudioChunk(data=pcm))

    # ------------------------------------------------------------------ assertions

    def _assert_connected(self) -> None:
        if self._ws is None:
            raise RuntimeError(
                "PipecatAgentAdapter: not connected. Did you forget to call connect()?"
            )
