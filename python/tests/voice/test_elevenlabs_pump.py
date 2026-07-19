"""
sc#740 Slice A — ElevenLabs continuous mic pump + ``is_connected()`` guard.

Python parity with ``javascript/src/voice/adapters/elevenlabs.ts`` ``pumpTick``
(:606-634), ``awaitingUserTurn`` SET/CLEAR (:485/:676), ``isConnected()`` override
(:531-534), ``startPump``/``stopPump`` (:563-582), disconnect stop-before-close
(:539), and the raced-close swallow (:630-633); plus the pre-turn ``call()`` guard
mirroring ``adapter.runtime.ts:249-254`` (``PendingTransportError`` throw).

Python has NO ``inputCallback`` SDK seam (unlike TS). The pump writes raw WS JSON
directly: ``self._ws.send(json.dumps({"user_audio_chunk": <b64>}))`` — the same
send seam as ``elevenlabs.py:279``. A 20 ms frame is exactly 960 bytes of PCM
(``PUMP_FRAME_BYTES``); the closing-silence frame is 960 all-zero bytes.

Offline — no network, no real EL socket. The pump seam (``self._ws.send``) is
mocked; the gated live server-VAD proof (A3b) is guarded by ``RUN_EL_HOSTED=1``.

Timing discipline: cadence tests never sleep on wall-clock for a single 20 ms
tick. They drive ``_pump_tick`` directly (deterministic) or let the loop run and
assert on FRAME COUNT / CONTENT, not on precise 20 ms spacing.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter
from scenario.voice.adapters.elevenlabs import (
    PUMP_FRAME_BYTES,
    PUMP_INTERVAL_S,
    SILENCE_FRAME,
)


# --------------------------------------------------------------------------- #
# Fakes / helpers                                                             #
# --------------------------------------------------------------------------- #


class FakePumpSocket:
    """In-memory EL WS that records every ``send`` and models liveness the way
    modern ``websockets`` does — via a ``state`` enum
    (``websockets.protocol.State``), NOT a ``closed`` attribute.

    Modern ``websockets`` (>=13, the ``ClientConnection`` that
    :func:`websockets.connect` returns on the version this repo pins) exposes
    ``state`` and has NO ``closed`` attribute — so a fake that only modelled
    ``closed`` would let a broken ``is_connected()`` (reading a nonexistent
    ``.closed``) pass in tests while raising ``AttributeError`` against a live
    socket. This fake exposes ``state`` (primary) and keeps a ``closed``
    convenience setter/getter that drives it, so the test exercises the real
    ``state`` code path. ``closed=True`` maps to ``State.CLOSED``.
    """

    def __init__(self) -> None:
        self.sent: list[str] = []
        from websockets.protocol import State

        self._State = State
        self.state = State.OPEN

    @property
    def closed(self) -> bool:
        return self.state is self._State.CLOSED

    @closed.setter
    def closed(self, value: bool) -> None:
        self.state = self._State.CLOSED if value else self._State.OPEN

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:  # pragma: no cover - not exercised here
        await asyncio.sleep(3600)
        return ""

    async def close(self) -> None:
        self.state = self._State.CLOSED

    # ----- parsed views -----

    @property
    def user_audio_chunks(self) -> list[bytes]:
        """base64-decoded PCM payload of every ``user_audio_chunk`` frame."""
        out: list[bytes] = []
        for s in self.sent:
            msg = json.loads(s)
            payload = msg.get("user_audio_chunk")
            if isinstance(payload, str):
                out.append(base64.b64decode(payload))
        return out


async def _connected_adapter(
    **kwargs: Any,
) -> tuple[ElevenLabsAgentAdapter, FakePumpSocket]:
    """Build an EL adapter wired to a fresh fake socket, already connected.

    ``connect()`` starts the pump; callers that want deterministic single-tick
    control should ``stop_pump()`` first or drive ``_pump_tick`` directly.
    """
    socket = FakePumpSocket()
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test", **kwargs)
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    return adapter, socket


def _decoded(sent: list[str]) -> list[bytes]:
    out: list[bytes] = []
    for s in sent:
        payload = json.loads(s).get("user_audio_chunk")
        if isinstance(payload, str):
            out.append(base64.b64decode(payload))
    return out


# --------------------------------------------------------------------------- #
# A1 — frame format on the wire                                               #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pump_emits_960b_user_audio_chunk_frames() -> None:
    """A1: after connect() a background task ticks ~20 ms and sends
    ``{"user_audio_chunk": <b64>}`` frames whose decoded PCM is exactly 960 B.

    Falsifier for "the pump is the SINGLE owner of idle silence": with ZERO
    caller ``send_audio``, EVERY frame the wire receives after the one-time
    connect init MUST be a 960B ``user_audio_chunk``. A second idle-silence
    source (a stray ``_send_silence_tail``, a differently-shaped keepalive
    frame, a wrong-size frame) would put a non-conforming send on the wire and
    FAIL this test — the assertion is over the actual wire traffic, not a spy
    on a method the idle path never calls.
    """
    adapter, socket = await _connected_adapter()
    try:
        # Snapshot the one-time connect init so we assert only on the pump's
        # idle traffic. There is exactly one init frame
        # (conversation_initiation_client_data).
        init_sends = list(socket.sent)
        assert len(init_sends) == 1
        assert json.loads(init_sends[0]).get("type") == "conversation_initiation_client_data"

        # Let the pump run briefly; assert on COUNT/CONTENT, not exact spacing.
        deadline = asyncio.get_running_loop().time() + 0.1
        while (
            asyncio.get_running_loop().time() < deadline
            and len(socket.sent) < len(init_sends) + 3
        ):
            await asyncio.sleep(PUMP_INTERVAL_S)

        # Every wire send AFTER the connect init is a conforming pump frame.
        idle_sends = socket.sent[len(init_sends):]
        assert len(idle_sends) >= 3, f"expected >=3 pump frames, got {len(idle_sends)}"
        for raw in idle_sends:
            msg = json.loads(raw)
            # Shape falsifier: ONLY the user_audio_chunk key — no keepalive
            # frame, no user_message, no other silence-emitting shape.
            assert set(msg.keys()) == {"user_audio_chunk"}, (
                f"non-pump frame reached the wire during idle pumping: {msg!r}"
            )
            # Size falsifier: decoded payload is exactly one 20ms frame.
            assert len(base64.b64decode(msg["user_audio_chunk"])) == 960
    finally:
        await adapter.disconnect()


# --------------------------------------------------------------------------- #
# A2 — three-way pumpTick gating + flag transitions                           #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pump_tick_three_way_gate_and_flag_transitions() -> None:
    """A2: one frame per tick in each of the 3 states; flag SET at agent-audio
    begins, CLEARED at enqueue-speech."""
    adapter, socket = await _connected_adapter()
    # Take manual control of ticks — no background racing.
    await adapter.stop_pump()
    socket.sent.clear()

    # State (c): closing silence — no queued speech, not awaiting → 960B zeros.
    assert adapter.awaiting_user_turn is False
    await adapter._pump_tick()
    assert len(socket.sent) == 1
    assert _decoded(socket.sent)[-1] == SILENCE_FRAME
    assert _decoded(socket.sent)[-1] == b"\x00" * 960

    # Agent audio begins → flag SET (mirror elevenlabs.ts:485).
    adapter._on_agent_audio_begin()
    assert adapter.awaiting_user_turn is True

    # State (b): awaiting user turn → send NOTHING this tick.
    before = len(socket.sent)
    await adapter._pump_tick()
    assert len(socket.sent) == before, "awaiting_user_turn must pause the mic"

    # New user turn enqueued → flag CLEARED (mirror elevenlabs.ts:676).
    adapter.enqueue_speech(b"\x11" * PUMP_FRAME_BYTES)
    assert adapter.awaiting_user_turn is False

    # State (a): queued speech present → feed the queued speech frame.
    before = len(socket.sent)
    await adapter._pump_tick()
    assert len(socket.sent) == before + 1
    assert _decoded(socket.sent)[-1] == b"\x11" * PUMP_FRAME_BYTES

    # send_audio — the PRIMARY runtime API — also clears the flag when a real
    # user turn is committed (mirror elevenlabs.ts:710 enqueueSpeech clear).
    # Re-arm the pause, then commit a turn via send_audio and assert it lifts.
    adapter._on_agent_audio_begin()
    assert adapter.awaiting_user_turn is True
    await adapter.send_audio(AudioChunk(data=b"\x00" * 8, transcript="hello"))
    assert adapter.awaiting_user_turn is False

    await adapter.disconnect()


@pytest.mark.asyncio
async def test_fallback_send_audio_routes_through_pump_no_direct_write():
    """P2 review fix: the pure-audio fallback path (silence mode / no-transcript)
    must NOT write audio directly to the WS while the background pump also runs
    — that would be two concurrent writers producing interleaved/oversized
    frames. Instead it ENQUEUES speech + closing-silence tail as fixed 960-byte
    pump frames, and the pump is the SINGLE writer emitting them at 20ms cadence.
    """
    adapter, socket = await _connected_adapter(turn_commit_mode="silence")
    # Manual pump control for a deterministic assertion.
    await adapter.stop_pump()
    socket.sent.clear()

    # Fallback path: raw speech, no transcript commit.
    await adapter.send_audio(AudioChunk(data=b"\x33" * 100))

    # send_audio itself wrote NOTHING to the socket — it only enqueued. The
    # pump is the single writer; nothing raced onto the wire during the call.
    assert socket.sent == [], "fallback must not write audio directly to the WS"
    # Speech (1 padded 960B frame) + closing-silence tail frames are queued.
    tail_frames = -(-adapter._silence_tail_bytes // PUMP_FRAME_BYTES)
    assert len(adapter._outbound_frames) == 1 + tail_frames

    # Drain via the pump: every emitted frame is exactly 960 bytes (fixed
    # cadence), never an arbitrary-sized chunk or a 16KB blob.
    while adapter._outbound_frames:
        await adapter._pump_tick()
    emitted = _decoded(socket.sent)
    assert len(emitted) == 1 + tail_frames
    assert all(len(f) == 960 for f in emitted), "pump must emit only 960B frames"
    # First frame is the speech (padded), remainder are the closing silence.
    assert emitted[0] == (b"\x33" * 100) + b"\x00" * (960 - 100)
    assert all(f == b"\x00" * 960 for f in emitted[1:])
    # Total closing silence covers at least the configured tail.
    assert sum(len(f) for f in emitted[1:]) >= adapter._silence_tail_bytes

    await adapter.disconnect()


# --------------------------------------------------------------------------- #
# A3a — server-VAD transition on the wire (UNGATED)                           #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pump_emits_silence_transition_without_caller_writes() -> None:
    """A3a: with the pump idle and ZERO caller send_audio, the wire carries
    >=3 consecutive all-zero 960B frames — the audio→silence transition EL's
    server VAD measures end-of-turn against."""
    adapter, socket = await _connected_adapter()
    try:
        deadline = asyncio.get_running_loop().time() + 0.15
        while (
            asyncio.get_running_loop().time() < deadline
            and len(socket.user_audio_chunks) < 3
        ):
            await asyncio.sleep(PUMP_INTERVAL_S)

        frames = socket.user_audio_chunks
        assert len(frames) >= 3
        # All idle frames are the closing-silence frame (all-zero, 960B).
        for payload in frames:
            assert payload == b"\x00" * 960
    finally:
        await adapter.disconnect()


# --------------------------------------------------------------------------- #
# A3b — real EL server-VAD end-of-turn (GATED RUN_EL_HOSTED=1)                 #
# --------------------------------------------------------------------------- #


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("RUN_EL_HOSTED") != "1",
    reason="gated live EL server-VAD proof; set RUN_EL_HOSTED=1 to run",
)
@pytest.mark.asyncio
async def test_real_server_vad_end_of_turn() -> None:
    """A3b: against a real EL session with NO caller send_audio, server-VAD
    end-of-turn fires from the pump's closing silence alone and an agent
    response is produced. GATED — does not run in CI."""
    agent_id = os.environ["EL_AGENT_ID"]
    api_key = os.environ["ELEVENLABS_API_KEY"]
    adapter = ElevenLabsAgentAdapter(agent_id=agent_id, api_key=api_key)
    async with adapter:
        # No caller send_audio — the pump's closing silence must drive an
        # agent turn on its own.
        chunk = await adapter.recv_audio(timeout=45.0)
        assert chunk.data, "expected agent audio from pump-driven server VAD"


# --------------------------------------------------------------------------- #
# A4 — is_connected predicate, both transitions                               #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_is_connected_predicate_both_transitions() -> None:
    """A4: base default True; EL override True after connect (ws open),
    False after disconnect (ws closed) AND False when ws is None."""
    from scenario.voice.adapter import VoiceAgentAdapter

    class _Base(VoiceAgentAdapter):
        async def connect(self) -> None:
            pass

        async def disconnect(self) -> None:
            pass

        async def send_audio(self, chunk: AudioChunk) -> None:
            pass

        async def recv_audio(self, timeout: float) -> AudioChunk:
            return AudioChunk(data=b"")

    assert _Base().is_connected() is True

    adapter, _socket = await _connected_adapter()
    assert adapter.is_connected() is True  # ws open

    await adapter.disconnect()
    assert adapter.is_connected() is False  # ws None after disconnect

    # Explicitly the closed-but-not-None transition too.
    adapter2, socket2 = await _connected_adapter()
    await adapter2.stop_pump()
    socket2.closed = True
    assert adapter2.is_connected() is False
    await adapter2.disconnect()


# --------------------------------------------------------------------------- #
# A5 — pre-turn connection guard in call()                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_call_raises_pending_transport_when_disconnected() -> None:
    """A5: call() checks is_connected() ONCE before send_audio/recv_audio;
    when False it raises PendingTransportError naming the adapter, and neither
    send_audio nor recv_audio is invoked."""
    from scenario.voice.adapter import VoiceAgentAdapter
    from scenario.voice.adapters._stub import PendingTransportError

    class _Disconnected(VoiceAgentAdapter):
        async def connect(self) -> None:
            pass

        async def disconnect(self) -> None:
            pass

        async def send_audio(self, chunk: AudioChunk) -> None:
            pass

        async def recv_audio(self, timeout: float) -> AudioChunk:
            return AudioChunk(data=b"")

        def is_connected(self) -> bool:
            return False

    adapter = _Disconnected()
    # Replace the real coroutines with spies to assert the guard short-circuits
    # BEFORE either is awaited; method-assign is the intended test seam.
    adapter.send_audio = AsyncMock()  # type: ignore[method-assign]
    adapter.recv_audio = AsyncMock(return_value=AudioChunk(data=b""))  # type: ignore[method-assign]

    class _Input:
        def __init__(self) -> None:
            self.new_messages: list[Any] = []

    with pytest.raises(PendingTransportError) as excinfo:
        # _Input is a minimal AgentInput stub supplying only new_messages.
        await adapter.call(_Input())  # type: ignore[arg-type]

    # Parity subclass: TransportNotConnectedError is-a PendingTransportError
    # and names the adapter class.
    assert "_Disconnected" in str(excinfo.value)
    adapter.send_audio.assert_not_awaited()
    adapter.recv_audio.assert_not_awaited()


@pytest.mark.asyncio
async def test_call_guard_does_not_suppress_first_chunk_timeout() -> None:
    """A5 (negative): the guard does NOT suppress FirstChunkTimeoutError — a
    connected adapter whose first recv times out still surfaces it."""
    from scenario.voice.adapter import FirstChunkTimeoutError, VoiceAgentAdapter

    class _Connected(VoiceAgentAdapter):
        response_timeout = 0.01

        async def connect(self) -> None:
            pass

        async def disconnect(self) -> None:
            pass

        async def send_audio(self, chunk: AudioChunk) -> None:
            pass

        async def recv_audio(self, timeout: float) -> AudioChunk:
            raise asyncio.TimeoutError

        def is_connected(self) -> bool:
            return True

    class _Input:
        def __init__(self) -> None:
            self.new_messages: list[Any] = []

    with pytest.raises(FirstChunkTimeoutError):
        # _Input is a minimal AgentInput stub supplying only new_messages.
        await _Connected().call(_Input())  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# A6 — start/stop/reset lifecycle                                             #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pump_start_stop_reset_lifecycle() -> None:
    """A6: start_pump idempotent (one task); stop_pump cancels the task, drops
    unsent frames, resets awaiting_user_turn; reconnect starts in closing
    silence (emits silence, not paused)."""
    adapter, socket = await _connected_adapter()

    # Idempotent start — a second start yields exactly one running task.
    task_before = adapter._pump_task
    adapter.start_pump()
    assert adapter._pump_task is task_before
    assert adapter._pump_task is not None and not adapter._pump_task.done()

    # Enqueue frames + set the flag, then stop.
    adapter.enqueue_speech(b"\x22" * PUMP_FRAME_BYTES)
    adapter._on_agent_audio_begin()
    assert adapter.awaiting_user_turn is True
    assert len(adapter._outbound_frames) > 0

    stopped = adapter._pump_task
    await adapter.stop_pump()
    assert stopped is not None and (stopped.cancelled() or stopped.done())
    assert len(adapter._outbound_frames) == 0
    assert adapter.awaiting_user_turn is False
    assert adapter._pump_task is None

    # Reconnect starts clean in closing-silence state.
    adapter.start_pump()
    socket.sent.clear()
    await adapter._pump_tick()
    assert _decoded(socket.sent)[-1] == b"\x00" * 960

    await adapter.disconnect()


# --------------------------------------------------------------------------- #
# A7 — disconnect races pump: no post-teardown send, no raise                 #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_tick_racing_disconnect_no_send_no_raise() -> None:
    """A7: stop_pump is ordered BEFORE ws close; a tick racing a closed/nulled
    ws neither raises out of the task nor sends after teardown."""
    adapter, socket = await _connected_adapter()

    # A tick that fires with a closed ws must swallow and not send.
    socket.closed = True
    sent_before = len(socket.sent)
    # Direct-drive a tick against the closed ws — must not raise, must not send.
    await adapter._pump_tick()
    assert len(socket.sent) == sent_before

    # And a tick with a nulled ws also swallows.
    adapter._ws = None
    await adapter._pump_tick()
    # Tear down the first adapter's pump before reassigning so its task is
    # cancelled+awaited (no orphan, no test-isolation bleed).
    await adapter.stop_pump()

    # Full disconnect: no send after it returns.
    adapter, socket = await _connected_adapter()
    await adapter.disconnect()
    sent_after_disconnect = len(socket.sent)
    # Any late tick attempt post-disconnect adds nothing (ws nulled).
    await adapter._pump_tick()
    assert len(socket.sent) == sent_after_disconnect


@pytest.mark.asyncio
async def test_tick_send_raising_mid_tick_is_swallowed_and_loop_survives() -> None:
    """A7 (real race): the ws closes/raises BETWEEN the is_connected() check and
    the ``await self._ws.send`` — i.e. ``send`` itself raises a
    ConnectionClosed-equiv. The exception must NOT propagate out of the pump
    task, and the background loop must keep running (re-enter and tick again).

    This exercises the actual try/except swallow around the send, not the
    pre-send gate: ``closed`` stays False so ``is_connected()`` passes and the
    tick reaches the send, which raises.
    """

    # A genuine close-race signal: the modern websockets client raises
    # ConnectionClosed (an OSError subtype via ConnectionError) when a send
    # lands on a socket that closed after the liveness check. Use ConnectionError
    # so we exercise the adapter's EXPECTED-close-race branch, not the
    # unexpected-error branch.
    class RaceThenRecoverSocket(FakePumpSocket):
        """Raises on the first N sends (the race), then succeeds — so we can
        prove the loop survived the raise and keeps ticking afterwards."""

        def __init__(self, raise_first: int) -> None:
            super().__init__()
            # Armed only AFTER connect() so the init send isn't the one that
            # raises — we want the PUMP's send to hit the race window.
            self._raise_left = 0
            self._arm_raises = raise_first
            self.raise_attempts = 0

        def arm(self) -> None:
            self._raise_left = self._arm_raises

        async def send(self, data: str) -> None:
            # state stays OPEN → is_connected() is True → the tick reaches
            # here and this raise IS the race window.
            if self._raise_left > 0:
                self._raise_left -= 1
                self.raise_attempts += 1
                raise ConnectionError("socket closed mid-send")
            await super().send(data)

    socket = RaceThenRecoverSocket(raise_first=2)
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test")
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    # Stop the auto-started pump so the init send lands cleanly, then arm the
    # race and drive ticks deterministically.
    await adapter.stop_pump()
    socket.arm()
    adapter.start_pump()
    try:
        # is_connected() must be True while send raises — proving we hit the
        # SEND swallow, not the pre-send gate.
        assert adapter.is_connected() is True

        # Direct-drive a tick whose send raises: must NOT propagate.
        await adapter._pump_tick()  # would raise ConnectionError if unswallowed
        assert socket.raise_attempts >= 1

        # The background loop must survive the raise and keep ticking: wait for
        # a real (non-raising) frame to land after the raises drain.
        deadline = asyncio.get_running_loop().time() + 0.2
        while (
            asyncio.get_running_loop().time() < deadline
            and len(socket.user_audio_chunks) < 1
        ):
            await asyncio.sleep(PUMP_INTERVAL_S)

        # The pump task never died (still running) and recovered onto the wire.
        assert adapter._pump_task is not None and not adapter._pump_task.done()
        assert len(socket.user_audio_chunks) >= 1
        assert socket.raise_attempts >= 1, "the race window (send raising) was never exercised"
    finally:
        await adapter.disconnect()


# --------------------------------------------------------------------------- #
# A8 — task cleanup: no orphan                                                #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pump_task_cancelled_and_awaited_on_disconnect() -> None:
    """A8: after disconnect the pump task is cancelled AND awaited (done), and
    NO orphaned-task error surfaces via the loop exception handler.

    asyncio reports "Task was destroyed but it is pending" and other
    background-task failures through ``loop.set_exception_handler`` — NOT the
    ``warnings`` module — so we install a temporary handler and assert it saw
    nothing (rather than relying on ``warnings.catch_warnings``, which would
    miss those messages).
    """
    loop = asyncio.get_running_loop()
    captured: list[dict[str, Any]] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: captured.append(context))
    try:
        adapter, _socket = await _connected_adapter()
        task = adapter._pump_task
        assert task is not None
        await adapter.disconnect()
        assert task.cancelled() or task.done()
        assert adapter._pump_task is None
        # Give the loop a beat to surface any orphaned-task/destroy-pending error.
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous)

    assert not captured, f"unexpected loop exceptions after disconnect: {captured}"


# --------------------------------------------------------------------------- #
# A-regression — non-EL / text runs create no pump task                       #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_non_el_adapter_creates_no_pump_task() -> None:
    """A-regression: a non-EL VoiceAgentAdapter has no pump task and its
    is_connected() default is True (no pump machinery leaks into the base)."""
    from scenario.voice.adapter import VoiceAgentAdapter

    class _NonEL(VoiceAgentAdapter):
        async def connect(self) -> None:
            pass

        async def disconnect(self) -> None:
            pass

        async def send_audio(self, chunk: AudioChunk) -> None:
            pass

        async def recv_audio(self, timeout: float) -> AudioChunk:
            return AudioChunk(data=b"")

    adapter = _NonEL()
    await adapter.connect()
    # No pump attribute on the base — the pump is EL-only machinery.
    assert not hasattr(adapter, "_pump_task") or adapter.__dict__.get("_pump_task") is None
    assert adapter.is_connected() is True
    await adapter.disconnect()
