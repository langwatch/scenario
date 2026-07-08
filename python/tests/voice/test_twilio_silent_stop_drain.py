"""
Issue #695 — the Twilio adapter must terminate its inbound queue on a silent /
tool-only completion (a #648-class dead-recv-loop hang) *and* survive the drain
loop's follow-up ``recv_audio`` after the call has ended.

The Twilio Media Streams loop (``_twilio_server.media_stream_loop``) is the
*producer* for the adapter's ``_inbound_queue``. Historically a turn that
completed WITHOUT trailing audio — a ``"stop"`` frame with nothing buffered (a
silent agent turn or a tool-only turn), or a socket close — left the queue
empty, so ``recv_audio`` blocked to ``response_timeout`` instead of returning
cleanly. This is the same latent hang fixed for ElevenLabs / generic WebSocket
in #648 and for OpenAI Realtime in #646/PR #647.

**Why these tests drive the REAL production wrapper.** In production the loop is
never reached via ``media_stream_loop`` directly — it goes through the
``_stream()`` closure inside ``build_app()`` (the ``/twilio/stream`` WebSocket
route). That wrapper nulls ``adapter._stream_ws`` / ``_stream_sid``
*synchronously, in the same task, immediately after the loop returns or raises*
(``_twilio_server.py`` ``_stream``'s ``finally``). Any test that calls
``media_stream_loop`` directly leaves those attributes set to whatever the loop
last wrote, so ``recv_audio``'s ``_assert_stream_live`` gate never fires — which
is exactly why an earlier version of this suite went green on a fix that still
crashed in production (reviewer P2 blocker on PR #697).

So each test here fetches the *actual* ``_stream`` endpoint off the built app's
routes and runs it. That reproduces the production teardown sequencing exactly:
the loop enqueues the terminal sentinel, then ``_stream``'s ``finally`` nulls the
transport state. The regression the fix targets is the drain loop's *second*
``recv_audio`` call (``_drain_agent_response`` always probes for tail silence
after the first chunk) landing after that reset. Pre-fix that second call raises
``RuntimeError: no live media stream``; post-fix it returns another empty chunk.
Each test therefore asserts BOTH the first ``recv_audio`` (the sentinel) and the
second (the post-teardown drain probe) behave cleanly.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import pytest

from scenario.voice import AudioChunk, TwilioAgentAdapter
from scenario.voice.adapters._twilio_server import TwilioWebhookServer
from scenario.voice.adapters._twilio_shared import build_media_frame

# recv_audio is handed a long nominal budget (what an un-fixed adapter would
# hang for); the outer ceiling fails the test fast if the empty-chunk terminal
# is missing. The fix returns instantly, far under the ceiling.
RECV_TIMEOUT = 30.0
OUTER_CEILING = 2.0
STREAM_SID = "MZ695"


def _start_frame(stream_sid: str = STREAM_SID, call_sid: str = "CA695") -> str:
    """The handshake frame Twilio sends as the first WS message on a new call."""
    return json.dumps(
        {"event": "start", "start": {"streamSid": stream_sid, "callSid": call_sid}}
    )


def _stop_frame() -> str:
    return json.dumps({"event": "stop"})


class _ScriptedWS:
    """A starlette-WebSocket double whose ``receive_text()`` serves ``frames``
    in order, then raises ``close_with`` (modelling a socket close).

    ``accept()`` is a no-op so the real ``_stream`` wrapper (which calls
    ``await ws.accept()`` before the loop) drives cleanly. Every test scripts an
    explicit terminal (a ``"stop"`` frame the loop returns on, or a
    ``close_with`` exception), so ``receive_text`` is never called past the
    programmed frames without one.
    """

    def __init__(
        self, frames: list[str], *, close_with: Optional[BaseException] = None
    ) -> None:
        self._frames = list(frames)
        self._idx = 0
        self._close_with = close_with
        self.sent: list[str] = []

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if self._idx < len(self._frames):
            msg = self._frames[self._idx]
            self._idx += 1
            return msg
        if self._close_with is not None:
            raise self._close_with
        raise AssertionError(  # pragma: no cover
            "scripted WS exhausted without a terminal frame"
        )

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


def _make_connected_adapter() -> TwilioAgentAdapter:
    """Construct an adapter with just enough state for the production
    ``_stream`` wrapper + ``recv_audio`` — without binding a real port
    (``connect()`` spins uvicorn).

    ``_assert_connected`` only checks ``_rest is not None``; ``recv_audio`` needs
    an inbound queue; the loop also touches ``_stream_connected``; ``_build_app``
    needs a ``_webhook_server``.
    """
    adapter = TwilioAgentAdapter(
        account_sid="AC" + "0" * 32,
        auth_token="secret",
        phone_number="+14155556959",
        public_base_url="https://example695.trycloudflare.com",
    )
    adapter._rest = object()  # type: ignore[assignment]
    adapter._inbound_queue = asyncio.Queue()
    adapter._stream_connected = asyncio.Event()
    adapter._webhook_server = TwilioWebhookServer(adapter)
    return adapter


def _production_stream_endpoint(adapter: TwilioAgentAdapter) -> Any:
    """Pull the REAL ``_stream`` closure off the built app's ``/twilio/stream``
    route.

    This is the exact function production runs per WebSocket connection: it
    ``accept()``s, calls ``media_stream_loop``, and — critically — nulls
    ``adapter._stream_ws`` / ``_stream_sid`` in its ``finally``. Driving it
    directly reproduces the production teardown sequencing that a bare
    ``media_stream_loop`` call skips.
    """
    app = adapter._build_app()
    for route in app.routes:
        if getattr(route, "path", None) == "/twilio/stream":
            return route.endpoint  # type: ignore[attr-defined]
    raise AssertionError("no /twilio/stream route on the built app")  # pragma: no cover


async def _drive_production(adapter: TwilioAgentAdapter, ws: _ScriptedWS) -> None:
    """Run the real ``_stream`` wrapper to its terminal over the scripted socket.

    On return, ``adapter._stream_ws`` / ``_stream_sid`` have been nulled by
    ``_stream``'s ``finally`` — exactly as in production after a call ends.
    """
    stream = _production_stream_endpoint(adapter)
    await stream(ws)


@pytest.mark.asyncio
async def test_stop_without_trailing_audio_drains_through_production_teardown():
    """A ``"stop"`` frame with no buffered audio (silent / tool-only turn),
    driven through the REAL ``_stream`` wrapper. After the wrapper nulls the
    transport state, the drain loop's first AND second ``recv_audio`` calls both
    return cleanly. Pre-fix the second call raises ``RuntimeError: no live media
    stream`` (the transport was nulled by ``_stream``'s ``finally``).
    """
    adapter = _make_connected_adapter()
    ws = _ScriptedWS([_start_frame(), _stop_frame()])

    await _drive_production(adapter, ws)

    # Production nulled the transport in _stream's finally — the very condition
    # that made recv_audio crash pre-fix.
    assert adapter._stream_ws is None
    assert adapter._stream_sid is None

    first = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(first, AudioChunk)
    assert first.data == b""  # empty terminal sentinel, not a hang

    # The drain's tail-silence probe — a SECOND recv_audio after teardown. This
    # is the call that raises "no live media stream" pre-fix.
    second = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(second, AudioChunk)
    assert second.data == b""


@pytest.mark.asyncio
async def test_socket_close_drains_through_production_teardown():
    """A socket close mid-stream (``receive_text`` raises ``WebSocketDisconnect``),
    driven through the REAL ``_stream`` wrapper. ``_stream`` swallows the
    disconnect and nulls the transport in its ``finally``; the terminal sentinel
    was enqueued before that. Both drain ``recv_audio`` calls return cleanly.
    Pre-fix the second raises ``RuntimeError: no live media stream``.
    """
    from starlette.websockets import WebSocketDisconnect

    adapter = _make_connected_adapter()
    ws = _ScriptedWS([_start_frame()], close_with=WebSocketDisconnect(code=1000))

    # _stream catches WebSocketDisconnect internally — it does NOT propagate.
    await _drive_production(adapter, ws)

    assert adapter._stream_ws is None
    assert adapter._stream_sid is None

    first = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(first, AudioChunk)
    assert first.data == b""

    second = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(second, AudioChunk)
    assert second.data == b""


@pytest.mark.asyncio
async def test_normal_audio_turn_still_drains_through_production_teardown():
    """No regression: a turn carrying trailing audio still yields the decoded
    PCM as the first chunk — the terminal sentinel lands *after* it, not instead
    of it — even though the real ``_stream`` wrapper has already nulled the
    transport state by the time the drain reads.
    """
    adapter = _make_connected_adapter()
    # 160 bytes of µ-law (~20ms). Under the 100ms batch threshold, so the
    # "stop" flush is what enqueues it — exactly the trailing-audio path.
    mulaw = bytes([0x7F]) * 160
    ws = _ScriptedWS(
        [_start_frame(), build_media_frame(STREAM_SID, mulaw), _stop_frame()]
    )

    await _drive_production(adapter, ws)

    assert adapter._stream_ws is None  # production teardown ran

    first = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(first, AudioChunk)
    assert len(first.data) > 0  # real audio survived; not clobbered by the sentinel

    # The terminal sentinel lands AFTER the real audio (FIFO), not instead of it:
    # the next chunk is the empty sentinel. Pins the ordering invariant — a fix
    # that enqueued the sentinel BEFORE the flush would fail here. And this
    # second call is also the post-teardown drain probe that crashed pre-fix.
    second = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert second.data == b""
