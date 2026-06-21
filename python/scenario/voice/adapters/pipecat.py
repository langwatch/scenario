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

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities
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
        self._inbound_queue: Optional[asyncio.Queue[AudioChunk]] = None
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
        return await asyncio.wait_for(self._inbound_queue.get(), timeout=timeout)

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
        buffered_mulaw = bytearray()
        BATCH_MS = 100

        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    # pipecat sometimes emits binary frames for audio; treat
                    # as raw µ-law payload if we see one.
                    buffered_mulaw.extend(raw)
                    if len(buffered_mulaw) >= (BATCH_MS * 8):
                        pcm = mulaw8k_to_pcm16_24k(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                        await self._inbound_queue.put(AudioChunk(data=pcm))
                    continue

                frame = parse_media_stream_frame(raw)
                if frame is None:
                    continue
                if frame.event == "media" and frame.payload_mulaw:
                    buffered_mulaw.extend(frame.payload_mulaw)
                    if len(buffered_mulaw) >= (BATCH_MS * 8):
                        pcm = mulaw8k_to_pcm16_24k(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                        await self._inbound_queue.put(AudioChunk(data=pcm))
                elif frame.event == "stop":
                    if buffered_mulaw:
                        pcm = mulaw8k_to_pcm16_24k(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                        await self._inbound_queue.put(AudioChunk(data=pcm))
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("PipecatAgentAdapter: recv loop exited with error", exc_info=True)

    # ------------------------------------------------------------------ assertions

    def _assert_connected(self) -> None:
        if self._ws is None:
            raise RuntimeError(
                "PipecatAgentAdapter: not connected. Did you forget to call connect()?"
            )
