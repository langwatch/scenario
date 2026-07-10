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

**Why these tests never call ``media_stream_loop``.** In production the loop is
reached through ``TwilioWebhookServer.run_stream_session``, whose ``finally``
nulls ``adapter._stream_ws`` / ``_stream_sid`` *synchronously, in the same task,
immediately after the loop returns or raises*. A test that calls
``media_stream_loop`` directly leaves those attributes set to whatever the loop
last wrote, so ``recv_audio``'s ``_assert_stream_live`` gate never fires — which
is exactly why an earlier version of this suite went green on a fix that still
crashed in production (reviewer P2 blocker on PR #697).

This suite therefore has two layers, and both are load-bearing:

1. ``TestRealRoute`` — the anti-drift gate. Boots the adapter's REAL uvicorn
   server, connects a REAL WebSocket client to the REAL ``/twilio/stream`` route,
   and drives the REAL production consumer (``_drain_agent_response``, which
   every ``call()`` turn runs). Nothing is stubbed between the socket and the
   drain, so it cannot go green on a fix that only works through a seam — and it
   fails if ``_stream()`` ever stops delegating to ``run_stream_session``. This
   is the layer that answers the P2 blocker.

2. The wrapper-level tests below it — fast, and able to script terminations a
   real socket cannot produce (a ``receive_text`` that raises a non-disconnect
   error; a second session on the same connected adapter). They drive
   ``run_stream_session`` directly, which layer 1 proves is what the route runs.

The layers are complements, and **neither subsumes the other**. Measured, not
assumed — delete the loop's sentinel ``put(...)`` but keep ``_stream_ended``:
every wrapper-level test in this file still PASSES, while three ``TestRealRoute``
tests go red (the JS twin blocks to ``responseTimeout`` — the original #695
hang). The wrapper layer cannot see the sentinel, because a consumer that is not
*already blocked* is served a synthesized empty chunk by the flag alone; only a
test with a live drain waiting at the instant the call ends catches it. Delete
the drain-side guard in ``recv_audio`` instead, and ``TestRealRoute`` goes red
with ``RuntimeError: no live media stream`` while three of the JS route tests
still pass. So do not trim either layer believing the other covers it.

The regression the fix targets is the drain calling ``recv_audio`` *after* the
transport reset. ``_drain_agent_response`` always probes for tail silence after
its first chunk, so it lands there on every call termination. Pre-fix that call
raises ``RuntimeError: no live media stream``; post-fix it returns an empty
chunk. The tests assert BOTH the first ``recv_audio`` (the sentinel) and the
second (the post-teardown drain probe) behave cleanly.

The reusable Twilio real-route harness (``make_connected_twilio_adapter``,
``serve_real_twilio_route``, ``drive_twilio_production``,
``wait_for_twilio_stream_teardown``, ``free_port``) now lives in the shared
``scenario.voice.testing.wrapper_harness`` module; this suite imports it and
keeps only the Twilio-specific socket doubles (``_ScriptedWS`` /
``_ControllableWS``) and frame builders local.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import pytest
import websockets

from scenario.voice import AudioChunk, TwilioAgentAdapter
from scenario.voice.adapters._twilio_shared import build_media_frame
from scenario.voice.testing.wrapper_harness import (
    drive_twilio_production,
    free_port,
    make_connected_twilio_adapter,
    serve_real_twilio_route,
    wait_for_twilio_stream_teardown,
)

# recv_audio is handed a long nominal budget (what an un-fixed adapter would
# hang for); the outer ceiling fails the test fast if the empty-chunk terminal
# is missing. The fix returns instantly, far under the ceiling.
RECV_TIMEOUT = 30.0
OUTER_CEILING = 2.0
# The real-route tests bind a port and run uvicorn, so they get a wider ceiling
# than the in-process wrapper tests — still far below any hang.
ROUTE_CEILING = 10.0
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

    ``accept()`` is a no-op so the real ``run_stream_session`` wrapper (which
    calls ``await ws.accept()`` before the loop) drives cleanly. Every test
    scripts an explicit terminal (a ``"stop"`` frame the loop returns on, or a
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


# ---------------------------------------------------------------- real route


@pytest.fixture
def route_adapter() -> TwilioAgentAdapter:
    adapter = make_connected_twilio_adapter(http_port=free_port())
    # Small drain budgets: a hang (the original #695 symptom) then fails inside
    # ROUTE_CEILING rather than stalling the suite.
    adapter.response_timeout = 5.0
    adapter.response_tail_silence = 0.5
    return adapter


class TestRealRoute:
    """Drive the REAL ``/twilio/stream`` route over a REAL WebSocket, and let the
    REAL production consumer (``_drain_agent_response``, which every ``call()``
    turn runs) read the result.

    These are the tests the P2 blocker on PR #697 asked for: they exercise the
    exact code path a live Twilio call takes, so they catch the class of bug
    where the sentinel is enqueued but ``recv_audio`` refuses to read it once the
    route's ``finally`` has nulled the transport. Every one of them raises
    ``RuntimeError: no live media stream`` out of ``_drain_agent_response``
    against the pre-fix adapter.
    """

    @pytest.mark.asyncio
    async def test_silent_stop_drains_cleanly(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """A silent / tool-only turn: ``stop`` frame, no audio ever buffered."""
        async with serve_real_twilio_route(route_adapter) as url:
            async with websockets.connect(url) as client:
                await client.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                drain = asyncio.create_task(route_adapter._drain_agent_response())
                await asyncio.sleep(0.05)  # let the drain block in recv_audio
                await client.send(_stop_frame())
                merged = await asyncio.wait_for(drain, timeout=ROUTE_CEILING)

        assert merged.data == b""  # clean terminal, not a hang and not a crash
        assert route_adapter._stream_ws is None  # the route's finally ran

    @pytest.mark.asyncio
    async def test_socket_close_without_stop_frame_drains_cleanly(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """Twilio drops the media socket with no ``stop`` frame and no audio."""
        async with serve_real_twilio_route(route_adapter) as url:
            async with websockets.connect(url) as client:
                await client.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                drain = asyncio.create_task(route_adapter._drain_agent_response())
                await asyncio.sleep(0.05)  # let the drain block in recv_audio
            # Leaving the ``async with`` closes the socket — the termination path.
            merged = await asyncio.wait_for(drain, timeout=ROUTE_CEILING)

        assert merged.data == b""
        assert route_adapter._stream_ws is None

    @pytest.mark.asyncio
    async def test_normal_audio_turn_survives_teardown(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """No regression: a turn carrying trailing audio still yields that audio
        through the real route — the sentinel terminates the drain after it, and
        does not replace it.
        """
        async with serve_real_twilio_route(route_adapter) as url:
            async with websockets.connect(url) as client:
                await client.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                drain = asyncio.create_task(route_adapter._drain_agent_response())
                await asyncio.sleep(0.05)
                # 160 bytes µ-law (~20ms) is under the 100ms batch threshold, so
                # the "stop" flush is what enqueues it: the trailing-audio path.
                await client.send(build_media_frame(STREAM_SID, bytes([0x7F]) * 160))
                await client.send(_stop_frame())
                merged = await asyncio.wait_for(drain, timeout=ROUTE_CEILING)

        assert len(merged.data) > 0  # the caller's audio reached the drain
        assert route_adapter._stream_ws is None

    @pytest.mark.asyncio
    async def test_turn_starting_after_hangup_drains_cleanly(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """The tightest form of the P0: the call has already ended and the route
        has already nulled the transport when the drain makes its FIRST
        ``recv_audio`` call — the next agent turn after the caller hung up.

        Pre-fix this raises ``RuntimeError: no live media stream`` immediately,
        with the terminal sentinel sitting unread in the queue.
        """
        async with serve_real_twilio_route(route_adapter) as url:
            async with websockets.connect(url) as client:
                await client.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                await client.send(_stop_frame())
            await wait_for_twilio_stream_teardown(route_adapter)
            assert route_adapter._stream_ws is None
            assert route_adapter._stream_sid is None

            # The agent turn begins only now, against a fully torn-down stream.
            merged = await asyncio.wait_for(
                route_adapter._drain_agent_response(), timeout=ROUTE_CEILING
            )

        assert merged.data == b""

    @pytest.mark.asyncio
    async def test_undrained_sentinel_does_not_truncate_the_next_call(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """A call that ends while NO drain is running leaves its terminal
        sentinel buffered. The next media-stream session on the same connected
        adapter must not serve that stale empty chunk as its first turn's audio.

        Without the queue purge at loop entry, session 2's drain reads the stale
        sentinel as its first chunk, breaks on it once tail-silence elapses, and
        the new call's first agent turn is truncated to silence — with its real
        audio stranded for the turn after.
        """
        # Agent 2 "thinks" for longer than tail silence before it speaks, so a
        # stale first chunk closes the turn before the real audio can land.
        route_adapter.response_tail_silence = 0.2
        speak_after = 0.6

        async with serve_real_twilio_route(route_adapter) as url:
            # Session 1: caller hangs up between turns; nothing consumes it.
            async with websockets.connect(url) as first:
                await first.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                await first.send(_stop_frame())
            await wait_for_twilio_stream_teardown(route_adapter)
            assert route_adapter._inbound_queue is not None
            assert route_adapter._inbound_queue.qsize() == 1  # sentinel, unread

            # Session 2: a Twilio reconnect / back-to-back call.
            async with websockets.connect(url) as second:
                await second.send(_start_frame("MZ695b", "CA695b"))
                for _ in range(int(ROUTE_CEILING / 0.01)):
                    if route_adapter._stream_sid == "MZ695b":
                        break
                    await asyncio.sleep(0.01)
                assert route_adapter._stream_sid == "MZ695b"

                drain = asyncio.create_task(route_adapter._drain_agent_response())

                async def _slow_agent() -> None:
                    await asyncio.sleep(speak_after)
                    # 800 bytes µ-law == the 100ms flush threshold, so the media
                    # branch flushes immediately — no stop frame needed.
                    await second.send(build_media_frame("MZ695b", bytes([0x7F]) * 800))

                speaker = asyncio.create_task(_slow_agent())
                merged = await asyncio.wait_for(drain, timeout=ROUTE_CEILING)
                # Join the speaker so a failure inside it surfaces here rather
                # than as a stray "task exception never retrieved" warning.
                await asyncio.wait_for(speaker, timeout=ROUTE_CEILING)

        assert len(merged.data) > 0  # the new call's real audio, not a stale sentinel

    @pytest.mark.asyncio
    async def test_audio_buffered_before_hangup_is_not_lost(
        self, route_adapter: TwilioAgentAdapter
    ) -> None:
        """Audio that landed in the queue before the hangup must still reach the
        drain even though the route already nulled the transport. Pre-fix the
        liveness assert fired first and that audio was dropped on the floor along
        with the crash.
        """
        async with serve_real_twilio_route(route_adapter) as url:
            async with websockets.connect(url) as client:
                await client.send(_start_frame())
                assert route_adapter._stream_connected is not None
                await asyncio.wait_for(
                    route_adapter._stream_connected.wait(), timeout=ROUTE_CEILING
                )
                await client.send(build_media_frame(STREAM_SID, bytes([0x7F]) * 160))
                await client.send(_stop_frame())
            await wait_for_twilio_stream_teardown(route_adapter)

            merged = await asyncio.wait_for(
                route_adapter._drain_agent_response(), timeout=ROUTE_CEILING
            )

        assert len(merged.data) > 0  # buffered audio recovered, not lost


class _ControllableWS:
    """A starlette-WebSocket double the test can feed mid-flight:
    ``receive_text()`` blocks until ``push()`` supplies a frame — a string
    frame, or an exception instance to raise (socket close / transport
    failure). Used for scenarios that need the loop *live and idle* at the
    moment the test calls ``recv_audio`` (the scripted double above always
    terminates first).
    """

    def __init__(self) -> None:
        self._queue: "asyncio.Queue[Any]" = asyncio.Queue()
        self.sent: list[str] = []

    def push(self, item: Any) -> None:
        self._queue.put_nowait(item)

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        item = await self._queue.get()
        if isinstance(item, BaseException):
            raise item
        return item

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


@pytest.mark.asyncio
async def test_stop_without_trailing_audio_drains_through_production_teardown():
    """A ``"stop"`` frame with no buffered audio (silent / tool-only turn),
    driven through the REAL ``_stream`` wrapper. After the wrapper nulls the
    transport state, the drain loop's first AND second ``recv_audio`` calls both
    return cleanly. Pre-fix the second call raises ``RuntimeError: no live media
    stream`` (the transport was nulled by the wrapper's ``finally``).
    """
    adapter = make_connected_twilio_adapter()
    ws = _ScriptedWS([_start_frame(), _stop_frame()])

    await drive_twilio_production(adapter, ws)

    # Production nulled the transport in run_stream_session's finally — the
    # very condition that made recv_audio crash pre-fix.
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
    driven through the REAL production wrapper, which swallows the disconnect
    and nulls the transport in its ``finally``; the terminal sentinel was
    enqueued before that. Both drain ``recv_audio`` calls return cleanly.
    Pre-fix the second raises ``RuntimeError: no live media stream``.
    """
    from starlette.websockets import WebSocketDisconnect

    adapter = make_connected_twilio_adapter()
    ws = _ScriptedWS([_start_frame()], close_with=WebSocketDisconnect(code=1000))

    # run_stream_session catches WebSocketDisconnect — it does NOT propagate.
    await drive_twilio_production(adapter, ws)

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
    of it — even though the real production wrapper has already nulled the
    transport state by the time the drain reads.
    """
    adapter = make_connected_twilio_adapter()
    # 160 bytes of µ-law (~20ms). Under the 100ms batch threshold, so the
    # "stop" flush is what enqueues it — exactly the trailing-audio path.
    mulaw = bytes([0x7F]) * 160
    ws = _ScriptedWS(
        [_start_frame(), build_media_frame(STREAM_SID, mulaw), _stop_frame()]
    )

    await drive_twilio_production(adapter, ws)

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


@pytest.mark.asyncio
async def test_transport_error_drains_through_production_teardown():
    """The THROW termination path (the third of stop / close / throw the
    production ``finally`` claims): ``receive_text`` raises a
    non-``WebSocketDisconnect`` error. ``run_stream_session`` propagates it —
    but the loop's ``finally`` enqueued the sentinel and the wrapper's
    ``finally`` nulled the transport first, so both drain ``recv_audio`` calls
    still return cleanly.
    """
    adapter = make_connected_twilio_adapter()
    ws = _ScriptedWS(
        [_start_frame()], close_with=RuntimeError("boom: transport failure")
    )

    with pytest.raises(RuntimeError, match="boom: transport failure"):
        await drive_twilio_production(adapter, ws)

    assert adapter._stream_ws is None  # teardown ran on the throw path
    assert adapter._stream_sid is None

    first = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert first.data == b""

    second = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert second.data == b""


@pytest.mark.asyncio
async def test_second_session_stale_flag_does_not_truncate_first_turn():
    """``_stream_ended`` is per-CALL state. After a completed first session, a
    second media-stream session on the SAME connected adapter (Twilio
    reconnect / back-to-back call) must not inherit the stale terminal flag —
    pre-fix, ``recv_audio`` on the new live call with a transiently empty queue
    would synthesize an empty "end of call" sentinel INSTANTLY and truncate the
    new call's first agent turn. With the loop-entry reset it waits for the
    real audio.
    """
    adapter = make_connected_twilio_adapter()

    # Session 1 completes silently and is fully drained.
    await drive_twilio_production(adapter, _ScriptedWS([_start_frame(), _stop_frame()]))
    s1 = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert s1.data == b""

    # Session 2 begins mid-call: started, nothing buffered yet.
    ws2 = _ControllableWS()
    session2 = asyncio.create_task(drive_twilio_production(adapter, ws2))
    ws2.push(_start_frame("MZ695b", "CA695b"))
    for _ in range(200):  # wait until the loop re-armed the transport
        if adapter._stream_ws is not None:
            break
        await asyncio.sleep(0.01)
    assert adapter._stream_ws is not None

    recv = asyncio.create_task(adapter.recv_audio(timeout=RECV_TIMEOUT))
    # Give a stale-flag bug its chance to resolve instantly with b"" before the
    # real audio is pushed — that instant-empty is exactly the regression.
    await asyncio.sleep(0.05)
    # 800 bytes µ-law == the 100ms flush threshold, so the media branch flushes
    # immediately — no stop frame needed for the audio to land.
    ws2.push(build_media_frame("MZ695b", bytes([0x7F]) * 800))
    audio = await asyncio.wait_for(recv, timeout=OUTER_CEILING)
    assert len(audio.data) > 0  # real audio, not a synthesized end-of-call sentinel

    # Session 2 then terminates normally and drains clean.
    ws2.push(_stop_frame())
    await asyncio.wait_for(session2, timeout=OUTER_CEILING)
    tail = await asyncio.wait_for(
        adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
    )
    assert tail.data == b""


@pytest.mark.asyncio
async def test_recv_audio_with_nulled_queue_raises_connection_error():
    """The disconnect-mid-drain guard: with ``_inbound_queue`` nulled (as
    ``disconnect()`` does) but the REST client still present, ``recv_audio``
    surfaces the explicit "inbound queue is gone" RuntimeError rather than an
    ``AttributeError`` — pinning the reordering guard the cascade keeps ahead
    of the queue reads.
    """
    adapter = make_connected_twilio_adapter()
    adapter._inbound_queue = None

    with pytest.raises(RuntimeError, match="inbound queue is gone"):
        await adapter.recv_audio(timeout=0.1)
