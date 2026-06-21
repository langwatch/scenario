"""
Issue #695 — the Twilio adapter must terminate its inbound queue on a silent /
tool-only completion (a #648-class dead-recv-loop hang).

The Twilio Media Streams loop (``_twilio_server.media_stream_loop``) is the
*producer* for the adapter's ``_inbound_queue``; ``recv_audio`` is a bare
``await _inbound_queue.get()``. Historically a turn that completed WITHOUT
trailing audio — a ``"stop"`` frame with nothing buffered (a silent agent turn
or a tool-only turn), or a socket close — left the queue empty, so ``recv_audio``
blocked to ``response_timeout`` instead of returning cleanly. This is the same
latent hang fixed for ElevenLabs / generic WebSocket in #648 and for OpenAI
Realtime in #646/PR #647.

The fix mirrors that reference pattern: on *any* terminal exit of the media
stream loop, enqueue an empty ``AudioChunk`` sentinel so the base
``_drain_agent_response`` loop (which breaks on an empty chunk) exits cleanly.

These tests drive ``media_stream_loop`` directly with a scripted WebSocket
double — no real port, no uvicorn. Each terminal-case test hands ``recv_audio``
a generous nominal ``timeout`` (the budget it would otherwise hang for) and
wraps the call in a short outer ceiling, so an un-fixed adapter that blocks on
the empty queue fails fast instead of stalling the suite — the empty-chunk fix
returns immediately, far under the ceiling.
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

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

    Every test scripts an explicit terminal (a ``"stop"`` frame the loop returns
    on, or a ``close_with`` exception), so ``receive_text`` is never called past
    the programmed frames without one — the trailing ``AssertionError`` guards
    against a test that accidentally lets the loop spin.
    """

    def __init__(
        self, frames: list[str], *, close_with: Optional[BaseException] = None
    ) -> None:
        self._frames = list(frames)
        self._idx = 0
        self._close_with = close_with
        self.sent: list[str] = []

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
    """Construct an adapter with just enough state for ``media_stream_loop`` +
    ``recv_audio`` — without binding a real port (``connect()`` spins uvicorn).

    ``_assert_connected`` only checks ``_rest is not None``; ``recv_audio`` needs
    an inbound queue; ``media_stream_loop`` also touches ``_stream_connected``.
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
    return adapter


async def _drive(adapter: TwilioAgentAdapter, ws: _ScriptedWS) -> None:
    """Run the media-stream loop to its terminal over the scripted socket."""
    server = TwilioWebhookServer(adapter)
    await server.media_stream_loop(ws)


@pytest.mark.asyncio
async def test_stop_without_trailing_audio_returns_empty_chunk():
    """A ``"stop"`` frame with no buffered audio (silent / tool-only turn)
    enqueues an empty terminal sentinel, so ``recv_audio`` returns cleanly
    instead of hanging. Pre-fix the queue stays empty and ``recv_audio`` blocks
    to the outer ceiling.
    """
    adapter = _make_connected_adapter()
    ws = _ScriptedWS([_start_frame(), _stop_frame()])

    await _drive(adapter, ws)

    chunk = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(chunk, AudioChunk)
    assert chunk.data == b""  # empty terminal, not a hang


@pytest.mark.asyncio
async def test_socket_close_returns_empty_chunk():
    """A socket close mid-stream (``receive_text`` raises ``WebSocketDisconnect``)
    enqueues the terminal sentinel before the disconnect propagates, so a
    ``recv_audio`` blocked on the queue returns cleanly. Pre-fix nothing is
    enqueued and ``recv_audio`` hangs to the outer ceiling.
    """
    from starlette.websockets import WebSocketDisconnect

    adapter = _make_connected_adapter()
    ws = _ScriptedWS([_start_frame()], close_with=WebSocketDisconnect(code=1000))

    with pytest.raises(WebSocketDisconnect):
        await _drive(adapter, ws)

    chunk = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(chunk, AudioChunk)
    assert chunk.data == b""


@pytest.mark.asyncio
async def test_normal_audio_turn_still_drains():
    """No regression: a turn carrying trailing audio still yields the decoded
    PCM as the first chunk — the terminal sentinel lands *after* it, not
    instead of it.
    """
    adapter = _make_connected_adapter()
    # 160 bytes of µ-law (~20ms). Under the 100ms batch threshold, so the
    # "stop" flush is what enqueues it — exactly the trailing-audio path.
    mulaw = bytes([0x7F]) * 160
    ws = _ScriptedWS(
        [_start_frame(), build_media_frame(STREAM_SID, mulaw), _stop_frame()]
    )

    await _drive(adapter, ws)

    first = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert isinstance(first, AudioChunk)
    assert len(first.data) > 0  # real audio survived; not clobbered by the sentinel

    # And the terminal sentinel lands AFTER the real audio (FIFO), not instead
    # of it: the next chunk is the empty sentinel. Pins the ordering invariant —
    # a fix that enqueued the sentinel BEFORE the flush would fail here.
    second = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert second.data == b""
