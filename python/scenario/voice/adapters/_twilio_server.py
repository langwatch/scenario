"""
TwilioWebhookServer: extracted FastAPI webhook + uvicorn lifecycle.

Owns one concern: serving Twilio's two routes (``/twilio/voice`` for the
TwiML response and ``/twilio/stream`` for the Media Streams WebSocket)
and keeping the uvicorn server alive until shutdown.

Separated from ``TwilioAgentAdapter`` so the adapter shrinks to the
audio-stream contract — the server-side concerns (route construction,
signature verification, WS framing) live in this module.

The server depends on the adapter for:
- ``auth_token`` + ``validate_signature`` (for X-Twilio-Signature check)
- ``allowed_callers`` (caller-filter check)
- ``public_base_url`` (to build the ``wss://.../twilio/stream`` URL)
- ``http_port`` (uvicorn binding)
- ``on_dtmf`` (callback into adapter state)

And writes back to the adapter:
- ``_inbound_queue`` (push received audio)
- ``_stream_connected``, ``_stream_sid``, ``_stream_ws`` (lifecycle signals)
- ``_call_sid`` (filled in from the Media Streams ``start`` frame if missing)
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import Any, TYPE_CHECKING

from ..audio_chunk import AudioChunk
from ._twilio_shared import (
    _redact_e164,
    mulaw8k_to_pcm16_24k,
    parse_media_stream_frame,
)

if TYPE_CHECKING:
    from .twilio import TwilioAgentAdapter


logger = logging.getLogger("scenario.voice.twilio")


class TwilioWebhookServer:
    """Owns the FastAPI app, uvicorn server, and Media Streams WS loop.

    The adapter constructs one of these per ``connect()`` lifecycle. The
    server reads adapter state through the passed reference so we
    don't have to keep two copies of mode flags / public URLs / etc.
    """

    def __init__(self, adapter: "TwilioAgentAdapter") -> None:
        self._adapter = adapter

    async def run(self) -> None:
        """Run the FastAPI/uvicorn webhook + WS server until shutdown is requested."""
        import uvicorn

        app = self.build_app()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self._adapter.http_port,
            log_level="warning",
            loop="asyncio",
        )
        server = uvicorn.Server(config)
        server_task = asyncio.create_task(server.serve())
        assert self._adapter._server_shutdown is not None
        await self._adapter._server_shutdown.wait()
        server.should_exit = True
        with suppress(Exception):
            await asyncio.wait_for(server_task, timeout=2.0)

    def verify_twilio_signature(
        self,
        request: Any,
        body: str,
        fields: dict,
    ) -> bool:
        """Verify the ``X-Twilio-Signature`` header on an inbound webhook.

        Twilio signs each webhook with HMAC-SHA1(auth_token, url+sorted_params)
        and sends the result base64-encoded in ``X-Twilio-Signature``. We
        reconstruct the same input and compare in constant time via the
        ``twilio.request_validator`` helper.

        Returns False (reject) on missing header, missing twilio lib, or
        any error in validation. Returns True only when the signature
        cleanly matches.
        """
        signature = request.headers.get("X-Twilio-Signature")
        if not signature:
            return False
        try:
            from twilio.request_validator import RequestValidator
        except Exception:
            # If the optional twilio package is missing we can't
            # validate, and unsigned requests are unsafe — fail closed.
            return False
        try:
            validator = RequestValidator(self._adapter.auth_token)
            # Reconstruct the canonical URL Twilio signed. Twilio uses the
            # absolute URL it called, including scheme + host + port +
            # path. starlette's request.url is that absolute form.
            url = str(request.url)
            # RequestValidator expects {key: str} not {key: list[str]} —
            # parse_qs gives lists; collapse single-element lists.
            params = {k: v[0] if isinstance(v, list) and v else v for k, v in fields.items()}
            return bool(validator.validate(url, params, signature))
        except Exception:
            logger.warning(
                "TwilioAgentAdapter: signature validation raised; treating as invalid",
                exc_info=True,
            )
            return False

    def build_app(self) -> Any:
        """Build the FastAPI app with Twilio voice + stream routes.

        Returned lazily so we don't import FastAPI at module load time.
        """
        from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
        from fastapi.responses import Response


        app = FastAPI()
        adapter = self._adapter

        async def _voice(request):
            """Return ``<Connect><Stream>`` TwiML — attaches our leg's audio
            bidirectionally to the WS. Same TwiML for both directions:

            - Answer mode: someone dialed our number; "our leg" is the
              inbound caller's leg. We hear them, they hear us.
            - Call mode: we originated a call via ``calls.create(to=X)``;
              "our leg" is the leg between our Twilio number and X. Once
              X picks up, the two-way audio on our leg flows through the
              WS — we "are" the caller, X is a real external endpoint.

            Twilio POSTs ``application/x-www-form-urlencoded``; we parse
            manually to avoid depending on python-multipart.
            """
            from urllib.parse import parse_qs

            body = (await request.body()).decode("utf-8", errors="replace")
            fields = parse_qs(body)
            from_number = (fields.get("From") or [""])[0]

            # Reject unsigned/forged requests before doing any further work
            # — once we get past this gate we've already trusted the From
            # field for the allowed_callers check.
            if adapter.validate_signature:
                if not self.verify_twilio_signature(request, body, fields):
                    logger.warning(
                        "TwilioAgentAdapter: rejecting voice webhook — "
                        "missing or invalid X-Twilio-Signature"
                    )
                    return Response(content="forbidden", status_code=403)

            if adapter.allowed_callers is not None and from_number not in adapter.allowed_callers:
                logger.info(
                    "TwilioAgentAdapter: rejecting call from %s (not in allowed_callers)",
                    _redact_e164(from_number),
                )
                return Response(
                    content="<Response><Reject/></Response>",
                    media_type="application/xml",
                )

            assert adapter.public_base_url is not None
            ws_url = (
                adapter.public_base_url.replace("https://", "wss://").replace("http://", "ws://")
                .rstrip("/")
                + "/twilio/stream"
            )
            twiml = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Response>'
                f'<Connect><Stream url="{ws_url}"/></Connect>'
                '</Response>'
            )
            return Response(content=twiml, media_type="application/xml")

        # NOTE: the module uses ``from __future__ import annotations``, which
        # stringifies annotations and breaks FastAPI's DI for the Request
        # parameter. Assign annotations explicitly so FastAPI sees the real
        # type objects and injects a Request instead of treating it as a query.
        _voice.__annotations__ = {"request": Request, "return": Response}
        app.post("/twilio/voice")(_voice)

        async def _stream(ws):
            await self.run_stream_session(ws)

        _stream.__annotations__ = {"ws": WebSocket, "return": None}
        app.websocket("/twilio/stream")(_stream)

        return app

    async def run_stream_session(self, ws: Any) -> None:
        """Production per-connection wrapper around :meth:`media_stream_loop`
        (twin of the JS ``TwilioWebhookServer.runStreamSession``): accept the
        socket, run the loop, swallow the disconnect, then — in a ``finally``
        that fires on stop, socket close, OR a raise — null the adapter's
        ``_stream_ws``/``_stream_sid`` transport state, exactly as the real
        ``/twilio/stream`` route does after a call ends.

        This is the seam tests must drive to reproduce the #695 teardown race:
        the terminal sentinel is enqueued inside the loop's own ``finally``,
        then THIS ``finally`` nulls the transport — so a ``recv_audio``
        following the reset must still drain cleanly. Driving
        ``media_stream_loop`` alone skips this reset and hides the bug (that
        was the shipped tests' flaw, PR #697 P2 blocker). Internal: production
        enters via the ``/twilio/stream`` route; not public API.
        """
        # Deferred import, matching this module's pattern of keeping fastapi
        # out of import-time dependencies (see build_app).
        from fastapi import WebSocketDisconnect

        adapter = self._adapter
        await ws.accept()
        logger.debug("TwilioAgentAdapter: WS connection accepted")
        try:
            await self.media_stream_loop(ws)
        except WebSocketDisconnect:
            logger.debug("TwilioAgentAdapter: WS disconnected")
        finally:
            adapter._stream_ws = None
            adapter._stream_sid = None

    async def media_stream_loop(self, ws: Any) -> None:
        """Per-call Media Streams loop: parse frames, enqueue audio, fire DTMF."""
        adapter = self._adapter
        assert adapter._inbound_queue is not None
        assert adapter._stream_connected is not None

        adapter._stream_ws = ws
        # ``_stream_ended`` AND the inbound queue are per-CALL state: re-arm and
        # purge both alongside ``_stream_ws`` so a second media-stream session on
        # the same connected adapter (Twilio reconnect, back-to-back call) starts
        # clean.
        #
        # The flag alone is not enough. The previous call's ``finally`` ENQUEUED a
        # terminal sentinel; if that call ended while no drain was running (the
        # caller hung up between turns), the sentinel is still sitting in the
        # queue. ``recv_audio`` drains a non-empty queue without checking
        # liveness, so the new call's first ``recv_audio`` would hand that stale
        # empty chunk to ``_drain_agent_response`` as its first chunk — and the
        # drain breaks on an empty chunk, truncating the new call's first agent
        # turn to silence and stranding its real audio for the turn after.
        #
        # No frame of THIS call has been enqueued yet, so anything present is the
        # previous session's residue and is safe to drop. Waiters are untouched:
        # a consumer already parked in ``get()`` stays parked for real audio.
        adapter._stream_ended = False
        while not adapter._inbound_queue.empty():
            adapter._inbound_queue.get_nowait()
        # Buffer µ-law for batched decoding — send_audio/recv_audio operate at
        # the AudioChunk level, so we coalesce ~100ms of incoming µ-law per
        # chunk to avoid thousands of tiny AudioChunk objects.
        buffered_mulaw = bytearray()
        BATCH_MS = 100

        try:
            while True:
                msg = await ws.receive_text()
                frame = parse_media_stream_frame(msg)
                if frame is None:
                    continue

                if frame.event == "start":
                    adapter._stream_sid = frame.stream_sid
                    if frame.call_sid and adapter._call_sid is None:
                        adapter._call_sid = frame.call_sid
                    adapter._stream_connected.set()

                elif frame.event == "media" and frame.payload_mulaw:
                    buffered_mulaw.extend(frame.payload_mulaw)
                    # 20ms per frame → flush every ~5 frames. Queue may be
                    # None if disconnect() raced ahead of the final frames;
                    # drop the chunk silently in that window.
                    if (
                        len(buffered_mulaw) >= (BATCH_MS * 8)
                        and adapter._inbound_queue is not None
                    ):
                        pcm = mulaw8k_to_pcm16_24k(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                        await adapter._inbound_queue.put(AudioChunk(data=pcm))

                elif frame.event == "dtmf" and frame.dtmf_digit:
                    logger.debug("TwilioAgentAdapter: received DTMF %s", frame.dtmf_digit)
                    if adapter.on_dtmf is not None:
                        try:
                            adapter.on_dtmf(frame.dtmf_digit)
                        except Exception:
                            logger.warning(
                                "TwilioAgentAdapter.on_dtmf callback raised; continuing",
                                exc_info=True,
                            )

                elif frame.event == "stop":
                    # Flush trailing audio then exit. After disconnect() has
                    # already reset state, _inbound_queue may be None — guard
                    # against a race where Twilio's final stop frame arrives
                    # after teardown started.
                    if buffered_mulaw and adapter._inbound_queue is not None:
                        pcm = mulaw8k_to_pcm16_24k(bytes(buffered_mulaw))
                        buffered_mulaw.clear()
                        await adapter._inbound_queue.put(AudioChunk(data=pcm))
                    return
        finally:
            # Terminal sentinel (#695; mirrors the #648 / #646 fix). Whether the
            # loop exits on a "stop" frame, a socket close (``receive_text``
            # raises ``WebSocketDisconnect``), or any error, mark the call ended
            # and enqueue an empty ``AudioChunk`` so a ``recv_audio`` blocked on
            # the inbound queue returns cleanly instead of hanging to
            # ``response_timeout`` on a silent / tool-only turn. All three
            # termination paths (stop / close / throw) funnel through this
            # ``finally``, so the sentinel is genuinely reachable on each.
            #
            # ``_stream_ended`` is set FIRST and unconditionally: the production
            # ``_stream()`` wrapper nulls ``_stream_ws``/``_stream_sid``
            # synchronously right after this loop returns, so ``recv_audio``'s
            # follow-up call would otherwise trip ``_assert_stream_live``. The
            # flag tells ``recv_audio`` to keep draining post-teardown rather
            # than assert liveness. Guard the disconnect race where
            # ``disconnect()`` already nulled the queue.
            adapter._stream_ended = True
            if adapter._inbound_queue is not None:
                await adapter._inbound_queue.put(AudioChunk(data=b""))
