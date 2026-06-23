"""Recv-loop crash/close attributable surfacing — creds-free.

Pins issue #498: when PipecatAgentAdapter._recv_loop terminates (crash or
clean peer close), recv_audio must raise PipecatRecvError FAST rather than
blocking the full timeout and then raising a bare RuntimeError/TimeoutError.

Three tests, each wrapping recv_audio(timeout=30.0) in asyncio.wait_for(5s):
- If the impl were still swallowing, recv_audio would block ~30s, the outer
  wait_for would fire asyncio.TimeoutError (NOT PipecatRecvError), and the
  test fails with an unmistakable "didn't get PipecatRecvError" message.
- If the impl is correct, PipecatRecvError escapes before the 5s guard fires.

The dual assertion (type + speed) with a single fixture mechanism is the only
way to prove BOTH "attributable" AND "fast fail" without a real pipecat bot.

Creds-free: websockets.connect is monkeypatched with a scripted fake.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any, Optional

import pytest

from scenario.voice import AudioChunk, PipecatAgentAdapter

# Import via the full module path (not from scenario.voice) so a missing
# symbol fails only at dereference, not at import-time collection.
from scenario.voice.adapters.pipecat import PipecatRecvError


# ---------------------------------------------------------------- #
# Scripted fake WebSocket                                          #
# ---------------------------------------------------------------- #
#
# Modelled on _FakeWebSocket in test_pipecat_adapter.py.  Additions:
#   - ``crash_with`` — if set, __anext__ raises this exception instead of
#     serving the next frame, simulating a recv-loop transport error.
#   - Clean close: calling ``end_stream()`` or init with no crash_with and
#     draining all frames will raise StopAsyncIteration from __anext__.

_SENTINEL_CLOSE = object()


class _ScriptedFakeWebSocket:
    """Stand-in for websockets.asyncio.client.ClientConnection.

    Serves queued frames on async iteration, then either crashes or closes
    depending on construction arguments.
    """

    def __init__(
        self,
        *,
        crash_with: Optional[Exception] = None,
    ) -> None:
        self.sent: list[str] = []
        self._inbox: asyncio.Queue[Any] = asyncio.Queue()
        self.closed = False
        # An exception to raise from __anext__ once the queue empties.
        # If None, raises StopAsyncIteration (clean close).
        self._crash_with = crash_with

    async def send(self, text: str) -> None:
        self.sent.append(text)

    def __aiter__(self) -> "_ScriptedFakeWebSocket":
        return self

    async def __anext__(self) -> Any:
        item = await self._inbox.get()
        if item is _SENTINEL_CLOSE:
            # Signal we absorbed the close sentinel; raise stop or crash.
            if self._crash_with is not None:
                raise self._crash_with
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        self.closed = True
        self._inbox.put_nowait(_SENTINEL_CLOSE)

    def feed(self, frame: str) -> None:
        """Enqueue one JSON text frame to serve on the next __anext__ call."""
        self._inbox.put_nowait(frame)

    def end_stream(self) -> None:
        """Signal clean close to __anext__."""
        self._inbox.put_nowait(_SENTINEL_CLOSE)


# ---------------------------------------------------------------- #
# Helpers                                                          #
# ---------------------------------------------------------------- #

def _make_media_frame(stream_sid: str, mulaw: bytes) -> str:
    """Build a Twilio Media Streams JSON media frame from raw µ-law bytes."""
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(mulaw).decode()},
        }
    )


# ---------------------------------------------------------------- #
# Fixtures                                                         #
# ---------------------------------------------------------------- #

@pytest.fixture
def scripted_ws(monkeypatch):
    """Return the fake WebSocket and monkeypatch websockets.connect.

    Caller sets up crash_with / feeds frames AFTER the fixture hands back
    the fake, because the adapter only calls connect() during the test body.

    Usage::

        fake = scripted_ws  # fixture value IS the fake
        fake._crash_with = ValueError("boom")  # or fake.end_stream()
        fake.feed(media_frame_str)
    """
    fake = _ScriptedFakeWebSocket()

    async def _fake_connect(url, **_):
        return fake

    monkeypatch.setattr("websockets.connect", _fake_connect)
    return fake


# ---------------------------------------------------------------- #
# Tests                                                            #
# ---------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_recv_loop_crash_surfaces_attributable_error(scripted_ws):
    """recv_loop crash → recv_audio raises PipecatRecvError fast.

    The crash exception (ValueError) must be:
      - The __cause__ of PipecatRecvError.
      - Mentioned in str(PipecatRecvError) so the message is attributable.

    Speed proof: recv_audio(timeout=30.0) wrapped in asyncio.wait_for(5.0).
    If the impl blocked the full 30s the outer guard would fire asyncio.TimeoutError,
    not PipecatRecvError, and pytest.raises would fail with an unmistakable mismatch.
    """
    boom = ValueError("pipeline exploded")
    scripted_ws._crash_with = boom
    scripted_ws.end_stream()  # immediately trigger crash on first __anext__

    adapter = PipecatAgentAdapter(url="ws://fake/ws")
    await adapter.connect()
    try:
        with pytest.raises(PipecatRecvError) as excinfo:
            await asyncio.wait_for(
                adapter.recv_audio(timeout=30.0),
                timeout=5.0,  # speed guard: if blocks >5s the impl is broken
            )

        # AC1 — cause is the original exception object (not a copy).
        assert excinfo.value.__cause__ is boom, (
            f"PipecatRecvError.__cause__ must be the original ValueError; "
            f"got: {excinfo.value.__cause__!r}"
        )

        # AC2 — message contains the crash type and text.
        msg = str(excinfo.value)
        assert "pipeline exploded" in msg, (
            f"PipecatRecvError message must mention the crash text; got: {msg!r}"
        )
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_recv_loop_clean_close_surfaces_attributable_error(scripted_ws):
    """recv_loop clean close (bot hung up) → recv_audio raises PipecatRecvError fast.

    Clean close = bot closed the WS with no crash; __anext__ raises
    StopAsyncIteration.  PipecatRecvError.__cause__ must be None and the
    message (lowercased) must contain 'closed' or 'hung up'.

    Speed proof: same asyncio.wait_for(5.0) guard as the crash test.
    """
    # No crash_with — end_stream() signals clean StopAsyncIteration.
    scripted_ws.end_stream()

    adapter = PipecatAgentAdapter(url="ws://fake/ws")
    await adapter.connect()
    try:
        with pytest.raises(PipecatRecvError) as excinfo:
            await asyncio.wait_for(
                adapter.recv_audio(timeout=30.0),
                timeout=5.0,
            )

        # AC1 — clean close has no cause.
        assert excinfo.value.__cause__ is None, (
            f"PipecatRecvError.__cause__ must be None for a clean close; "
            f"got: {excinfo.value.__cause__!r}"
        )

        # AC2 — message signals the peer closed the connection.
        msg = str(excinfo.value).lower()
        assert "closed" in msg or "hung up" in msg, (
            f"PipecatRecvError message (lowercased) must contain 'closed' or 'hung up'; "
            f"got: {msg!r}"
        )
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_audio_then_close_returns_turn_then_surfaces_close(scripted_ws):
    """Turn 1 audio delivered OK; turn 2 recv raises PipecatRecvError.

    Mirrors the #498 failure mode:
      - _recv_loop delivers one 100ms batch of audio (turn 1), then the bot
        closes the WebSocket cleanly.
      - First recv_audio(timeout=...) returns a non-empty AudioChunk.
      - Second recv_audio(timeout=30.0) raises PipecatRecvError fast (not
        after a 30s hang).

    The 5s asyncio.wait_for guard on the SECOND recv_audio is the speed proof:
    if the impl had not been fixed it would block the full 30s while the
    inbound queue is silent, then raise a bare asyncio.TimeoutError.
    """
    # 100ms of µ-law silence: 8000 samples/s × 0.1s = 800 bytes.
    # This is the same batch size the recv_loop buffers before enqueueing.
    mulaw_batch = b"\x7f" * 800

    # We need the adapter connected to know its stream_sid.  Connect first,
    # then feed the frame (stream_sid is generated in connect()).
    adapter = PipecatAgentAdapter(url="ws://fake/ws")
    await adapter.connect()
    try:
        # Feed one 100ms media frame, then end the stream cleanly.
        # connect() fabricates stream_sid; assert to narrow Optional[str] -> str.
        assert adapter.stream_sid is not None
        scripted_ws.feed(_make_media_frame(adapter.stream_sid, mulaw_batch))
        scripted_ws.end_stream()

        # Turn 1 recv — must succeed and return a non-empty chunk.
        chunk = await adapter.recv_audio(timeout=5.0)
        assert isinstance(chunk, AudioChunk), (
            f"first recv_audio must return an AudioChunk; got: {chunk!r}"
        )
        assert len(chunk.data) > 0, "first AudioChunk must contain PCM16 bytes"

        # Turn 2 recv — transport is gone; must raise PipecatRecvError fast.
        with pytest.raises(PipecatRecvError):
            await asyncio.wait_for(
                adapter.recv_audio(timeout=30.0),
                timeout=5.0,  # speed guard
            )

        # Turn 3 recv — the queue is now fully drained. This exercises the
        # fail-fast branch (loop done + empty queue) that must NOT block or
        # re-grow the queue; it still raises the same attributable error.
        with pytest.raises(PipecatRecvError):
            await asyncio.wait_for(
                adapter.recv_audio(timeout=30.0),
                timeout=5.0,
            )
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_stop_event_terminates_loop_and_surfaces_recv_error(scripted_ws):
    """A Twilio ``stop`` event ends the recv loop via its ``return`` path — the
    most common real termination (bot signals end-of-call). The ``finally`` must
    still mark the loop done and enqueue the sentinel, so recv_audio surfaces an
    attributable PipecatRecvError (clean close, no crash cause) rather than
    blocking the full timeout. Guards the ``stop``-branch exit, which the other
    surfacing tests do not reach.
    """
    adapter = PipecatAgentAdapter(url="ws://fake/ws")
    await adapter.connect()
    try:
        assert adapter.stream_sid is not None
        scripted_ws.feed(
            json.dumps({"event": "stop", "streamSid": adapter.stream_sid})
        )
        with pytest.raises(PipecatRecvError) as excinfo:
            await asyncio.wait_for(adapter.recv_audio(timeout=30.0), timeout=5.0)
        # stop is a graceful end → clean-close branch (no crash cause).
        assert excinfo.value.__cause__ is None, (
            f"stop-event termination must have no crash cause; "
            f"got: {excinfo.value.__cause__!r}"
        )
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_real_websocket_close_after_turn1_surfaces_recv_error():
    """#498 over a REAL websockets transport (no mock, no creds).

    A real in-process server sends one media turn, then closes the socket
    normally. The adapter's FIRST recv_audio returns the turn-1 audio; the NEXT
    recv_audio (turn 2's first chunk) must raise PipecatRecvError — proving the
    fix fires against genuine websockets close semantics (normal closure ends
    async-iteration cleanly in websockets 16.0), not only the unit test's
    mocked StopAsyncIteration. Guards against a transport-library upgrade
    silently changing close behavior so the clean-close branch stops firing.
    """
    import websockets

    async def handler(ws):
        # The adapter sends a synthetic `connected` then `start` frame on
        # connect(); read both, then send one 100ms µ-law media batch and close
        # normally. The recv loop does not filter inbound media by streamSid.
        await ws.recv()  # connected
        await ws.recv()  # start
        await ws.send(json.dumps({
            "event": "media",
            "streamSid": "MZtest",
            "media": {"payload": base64.b64encode(b"\x7f" * 800).decode()},
        }))
        await ws.close()  # normal closure (code 1000)

    server = await websockets.serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    a = PipecatAgentAdapter(url=f"ws://127.0.0.1:{port}/stream")
    await a.connect()
    try:
        # Turn 1: audio arrives over the real wire.
        first = await asyncio.wait_for(a.recv_audio(timeout=10.0), timeout=8.0)
        assert isinstance(first, AudioChunk) and first.data, "turn-1 audio must arrive"
        # Turn 2: the server already closed → attributable error, fast (the
        # 8s outer guard proves it does not block the 10s response timeout).
        with pytest.raises(PipecatRecvError) as ei:
            await asyncio.wait_for(a.recv_audio(timeout=10.0), timeout=8.0)
        # Normal close → clean-close branch: no crash cause, named in message.
        assert ei.value.__cause__ is None, (
            f"normal close must hit the clean-close branch (no __cause__); "
            f"got {ei.value.__cause__!r}"
        )
        msg = str(ei.value).lower()
        assert "closed" in msg or "hung up" in msg, msg
    finally:
        await a.disconnect()
        server.close()
        await server.wait_closed()
