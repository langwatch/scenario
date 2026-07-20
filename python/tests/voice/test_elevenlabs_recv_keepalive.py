"""
Regression test for issue #493 — ``ElevenLabsAgentAdapter.recv_audio`` must
tolerate a silent-but-pinging stretch instead of timing out spuriously.

The hosted EL ConvAI agent can fall silent for a stretch (a tool call, a RAG
lookup, a model processing pause) during which the WebSocket receives only
keep-alive ``ping`` frames and no ``audio`` frames. Observed in the wild: a
~30s silent stretch carried nothing but pings, the socket stayed healthy the
whole time, and yet ``recv_audio`` aborted the turn with
``asyncio.TimeoutError``.

Root cause (``scenario/voice/adapters/elevenlabs.py`` ``recv_audio``): the
deadline is computed ONCE as ``now + timeout`` and is never refreshed when a
message arrives. ``timeout`` is therefore the maximum cumulative time to
receive the next *audio* frame — but a received ping proves the socket is
alive and should keep the connection alive past the nominal audio-wait
budget. Only a *dead* socket (no pings AND no audio) should time out.

The keepalive-aware fix (a coder does that next) will treat ANY received
message — ping included — as a liveness signal that resets the audio-wait
deadline. This test pins the required behaviour:

    pings arriving steadily, each gap well under ``timeout``, for a TOTAL
    elapsed time LONGER than ``timeout``, followed by an audio frame
    => recv_audio returns the audio and does NOT raise.

Under the current cumulative-deadline code the audio arrives after the budget
is spent, so ``recv_audio`` raises ``asyncio.TimeoutError`` — this test is RED
on ``main`` by construction. A keepalive-aware deadline reset turns it GREEN.

No real network: ``websockets.connect`` is patched to a mock whose ``recv()``
serves programmed frames with small ``asyncio.sleep`` gaps so the test runs in
well under a second.
"""

import asyncio
import base64
import json
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter
from scenario.voice.adapters import elevenlabs as elevenlabs_module


# Timing budget. Each ping gap is comfortably under TIMEOUT (so a
# keepalive-aware fix keeps the socket alive), but the pings span a TOTAL
# wall-clock stretch well beyond TIMEOUT before the audio arrives (so the
# current cumulative-deadline code exhausts its budget and raises).
TIMEOUT = 0.30          # nominal audio-wait passed to recv_audio
PING_GAP = 0.08         # delay before each ping frame; < TIMEOUT
NUM_PINGS = 8           # 8 * 0.08 = 0.64s of pinging > TIMEOUT (0.30s)
AUDIO_GAP = 0.08        # delay before the final audio frame

# Invariant: the total pinging stretch MUST exceed TIMEOUT, else the test is
# no longer RED on pre-fix code (it would pass trivially).
assert NUM_PINGS * PING_GAP > TIMEOUT, (
    f"timing invariant broken: {NUM_PINGS} * {PING_GAP} = {NUM_PINGS * PING_GAP} "
    f"<= TIMEOUT={TIMEOUT}; adjust NUM_PINGS/PING_GAP so the ping stretch exceeds TIMEOUT"
)


def _make_pinging_then_audio_ws(pcm_payload: bytes) -> AsyncMock:
    """A mock WS whose ``recv()`` yields a run of pings then one audio frame.

    Each frame is preceded by a small ``asyncio.sleep`` so the silent stretch
    elapses in real (loop) time, letting the adapter's deadline arithmetic
    play out exactly as it would against a slow-but-healthy hosted agent.
    """
    b64_audio = base64.b64encode(pcm_payload).decode()

    # NUM_PINGS keep-alive frames (real EL nested wire shape), then audio.
    frames: list[tuple[float, str]] = [
        (
            PING_GAP,
            json.dumps(
                {"type": "ping", "ping_event": {"event_id": i, "ping_ms": 5}}
            ),
        )
        for i in range(NUM_PINGS)
    ]
    frames.append(
        (AUDIO_GAP, json.dumps({"type": "audio", "audio_event": {"audio_base_64": b64_audio}}))
    )

    call_index = 0

    async def fake_recv():
        nonlocal call_index
        delay, msg = frames[call_index]
        call_index += 1
        await asyncio.sleep(delay)
        return msg

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()
    return mock_ws


@pytest.mark.asyncio
async def test_recv_audio_tolerates_silent_but_pinging_stretch():
    """A silent-but-pinging stretch longer than ``timeout`` must NOT abort.

    RED on current main: the cumulative ``deadline = now + timeout`` is never
    refreshed, so after ~``TIMEOUT`` of pings the budget is spent and the
    adapter raises ``asyncio.TimeoutError`` before the audio frame is reached.

    GREEN once recv_audio resets its deadline on each received message
    (pings are liveness signals): the audio frame is then returned.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    pcm_payload = b"\x12\x34" * 8  # 16 bytes of dummy PCM16
    mock_ws = _make_pinging_then_audio_ws(pcm_payload)

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()

        # The pings span ~0.64s; TIMEOUT is 0.30s. A keepalive-aware adapter
        # stays alive (each gap < TIMEOUT) and returns the audio. The current
        # adapter exhausts its one-shot budget and raises TimeoutError here.
        result = await adapter.recv_audio(timeout=TIMEOUT)

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_payload


@pytest.mark.asyncio
async def test_recv_audio_still_times_out_on_truly_dead_socket():
    """Guard the fix doesn't make recv_audio hang forever.

    A genuinely dead socket — no pings, no audio, ``recv()`` just blocks —
    must still surface a timeout rather than hanging. A keepalive-aware
    implementation should reset its deadline only on RECEIVED messages, so a
    silent socket that sends nothing still trips the per-wait deadline.

    This passes on current main already (the cumulative deadline trips); it is
    here as the companion guard so a keepalive-aware fix that resets the
    deadline keeps a hard wall against an indefinitely silent socket.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")

    async def never_returns():
        # Sleep far past any reasonable timeout; recv yields nothing.
        await asyncio.sleep(60)
        raise AssertionError("recv() should not have completed")

    mock_ws = AsyncMock()
    mock_ws.recv = never_returns
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        with pytest.raises(asyncio.TimeoutError):
            await adapter.recv_audio(timeout=TIMEOUT)


# --------------------------------------------------------------------------- #
# Issue #829 — absolute hard-ceiling backstop on top of the keepalive-aware   #
# sliding idle deadline above.                                                #
# --------------------------------------------------------------------------- #
#
# #493 (tested above) made ``recv_audio`` tolerate a silent-but-pinging
# stretch by resetting the idle deadline on every received frame, pings
# included — but that fix deliberately left recv_audio willing to wait
# *forever* as long as pings kept arriving (see the "Design decision" note in
# the ``recv_audio`` docstring at the time). EL ConvAI ping indefinitely on a
# turn it will never answer with audio (e.g. after it ends/transfers its
# turn), so that unbounded wait would wedge a multi-turn run forever.
#
# The #829 fix adds ``KEEPALIVE_HARD_CEILING_S``: an absolute wall-clock
# ceiling, computed ONCE per ``recv_audio`` call and NOT reset by pings. These
# tests monkeypatch the module constant down to a small value so they run in
# well under a second, mirroring how ``TIMEOUT``/``PING_GAP`` are scaled down
# above for the #493 tests.

# Scaled-down timings for the hard-ceiling tests. HARD_CEILING must be >=
# IDLE_TIMEOUT (recv_audio's own ``timeout`` argument) so
# ``max(timeout, KEEPALIVE_HARD_CEILING_S)`` actually selects the ceiling —
# otherwise these tests would degenerate into re-testing the idle deadline.
IDLE_TIMEOUT = 0.10   # recv_audio's own per-call idle-wait budget
# NOT named PING_GAP: that name is already bound at module level (0.08, above)
# for the #493 tests. A same-named module-level assignment here would REBIND
# that global for the rest of the module's lifetime — the #493 test functions
# read PING_GAP at call time (after the whole module has finished importing),
# so they'd silently pick up this smaller value instead of their own.
CEILING_PING_GAP = 0.03  # delay before each ping frame; < IDLE_TIMEOUT so pings keep re-arming it
HARD_CEILING = 0.25   # scaled-down stand-in for KEEPALIVE_HARD_CEILING_S (real value: 45s)

assert CEILING_PING_GAP < IDLE_TIMEOUT, (
    f"timing invariant broken: CEILING_PING_GAP={CEILING_PING_GAP} must be < "
    f"IDLE_TIMEOUT={IDLE_TIMEOUT} so the idle deadline never trips on its own"
)
assert HARD_CEILING >= IDLE_TIMEOUT, (
    f"timing invariant broken: HARD_CEILING={HARD_CEILING} must be >= IDLE_TIMEOUT="
    f"{IDLE_TIMEOUT} so max(timeout, HARD_CEILING) actually selects the ceiling"
)


def _make_endless_pinging_ws() -> AsyncMock:
    """A mock WS whose ``recv()`` yields an unbounded stream of pings, each
    preceded by a :data:`CEILING_PING_GAP` sleep, and NEVER an audio frame —
    modelling a turn EL ConvAI will never answer with audio."""
    call_index = 0

    async def fake_recv():
        nonlocal call_index
        await asyncio.sleep(CEILING_PING_GAP)
        event_id = call_index
        call_index += 1
        return json.dumps(
            {"type": "ping", "ping_event": {"event_id": event_id, "ping_ms": 5}}
        )

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()
    return mock_ws


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_recv_audio_hard_ceiling_fires_despite_endless_pings(monkeypatch):
    """Issue #829: steady pings alone must NOT let recv_audio wait forever.

    Each ping gap (``CEILING_PING_GAP``) is comfortably under ``IDLE_TIMEOUT``,
    so the keepalive-aware sliding idle deadline (#493) is re-armed every time and
    would, on its own, let this run indefinitely. But the pings never stop and
    audio never arrives — the total pinging stretch is unbounded, and greatly
    exceeds the (scaled-down) ``KEEPALIVE_HARD_CEILING_S``. The absolute
    hard-ceiling backstop must fire and raise ``asyncio.TimeoutError`` instead
    of hanging.

    ``@pytest.mark.timeout(5)`` is a safety net, not the behavior under test:
    if the hard ceiling regresses back to "wait forever on pings", this test
    fails fast instead of hanging the suite.
    """
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", HARD_CEILING)

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_endless_pinging_ws()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()

        with pytest.raises(asyncio.TimeoutError):
            await adapter.recv_audio(timeout=IDLE_TIMEOUT)


@pytest.mark.asyncio
async def test_recv_audio_succeeds_when_slow_agent_responds_before_hard_ceiling(monkeypatch):
    """Issue #829 guard: the hard ceiling must not punish a genuinely slow —
    but eventually responding — agent.

    A few pings arrive (each gap < ``IDLE_TIMEOUT``, so the sliding idle
    deadline tolerates them per #493) and THEN audio arrives, all well before
    the (scaled-down) ``KEEPALIVE_HARD_CEILING_S`` elapses. ``recv_audio``
    must still return the audio normally — the ceiling bounds a
    pings-but-no-audio stretch, not a merely slow one.

    Monkeypatches the same scaled-down ``HARD_CEILING`` as the fires-despite-
    endless-pings test above: against the real 45s default this scenario
    would trivially pass regardless of whether the ceiling logic is correct,
    so exercising the actual (scaled) boundary is what makes this test
    meaningful.
    """
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", HARD_CEILING)

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    pcm_payload = b"\x56\x78" * 8  # 16 bytes of dummy PCM16
    b64_audio = base64.b64encode(pcm_payload).decode()

    # 3 pings (0.09s of pinging) then audio, ~0.14s total — comfortably under
    # both IDLE_TIMEOUT-per-gap (0.10s) and HARD_CEILING (0.25s).
    frames: list[tuple[float, str]] = [
        (
            CEILING_PING_GAP,
            json.dumps({"type": "ping", "ping_event": {"event_id": i, "ping_ms": 5}}),
        )
        for i in range(3)
    ]
    frames.append(
        (CEILING_PING_GAP, json.dumps({"type": "audio", "audio_event": {"audio_base_64": b64_audio}}))
    )
    assert sum(delay for delay, _ in frames) < HARD_CEILING, (
        "timing invariant broken: total frame delay must stay under HARD_CEILING "
        "so this test actually proves the slow-but-responding path, not the ceiling"
    )

    call_index = 0

    async def fake_recv():
        nonlocal call_index
        delay, msg = frames[call_index]
        call_index += 1
        await asyncio.sleep(delay)
        return msg

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await adapter.recv_audio(timeout=IDLE_TIMEOUT)

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_payload
