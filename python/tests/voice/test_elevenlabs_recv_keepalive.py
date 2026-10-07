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
        try:
            # The pings span ~0.64s; TIMEOUT is 0.30s. A keepalive-aware adapter
            # stays alive (each gap < TIMEOUT) and returns the audio. The current
            # adapter exhausts its one-shot budget and raises TimeoutError here.
            result = await adapter.recv_audio(timeout=TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()

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
        try:
            with pytest.raises(asyncio.TimeoutError):
                await adapter.recv_audio(timeout=TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()


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
        try:
            with pytest.raises(asyncio.TimeoutError):
                await adapter.recv_audio(timeout=IDLE_TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()


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
        try:
            result = await adapter.recv_audio(timeout=IDLE_TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_payload


# ---------------------------------------------------------------------------
# Issue #891: the two bounds must be told apart in the error
#
# Both bounds used to raise the same bare "recv_audio timed out", so the reader
# could not tell a socket that went completely quiet from one that pinged
# steadily and never spoke. Those are different problems with different fixes,
# and at the default budget (idle 60s, ceiling max(60, 45) = 60s) they even
# expire at the same instant, so the text is the only thing separating them.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recv_audio_silent_socket_reports_the_idle_deadline():
    """A socket that never sends anything reports the IDLE deadline, names
    response_timeout, and links the troubleshooting anchor."""
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")

    async def fake_recv():
        await asyncio.sleep(3600)  # never answers

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            with pytest.raises(asyncio.TimeoutError) as excinfo:
                await adapter.recv_audio(timeout=IDLE_TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()

    message = str(excinfo.value)
    assert f"The idle deadline of {IDLE_TIMEOUT:g}s elapsed" in message
    assert "not even a keepalive ping" in message
    assert "response_timeout" in message
    assert "voice/troubleshooting#receiveaudio-timed-out-hosted-elevenlabs" in message
    assert "absolute ceiling" not in message


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_recv_audio_endless_pings_report_the_absolute_ceiling(monkeypatch):
    """A socket that pings forever without speaking reports the CEILING, which
    is the other diagnosis entirely."""
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", HARD_CEILING)

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_endless_pinging_ws()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            with pytest.raises(asyncio.TimeoutError) as excinfo:
                await adapter.recv_audio(timeout=IDLE_TIMEOUT)
        finally:
            # connect() started the mic pump; stop it before teardown.
            await adapter.disconnect()

    message = str(excinfo.value)
    assert f"The absolute ceiling of {HARD_CEILING:g}s elapsed" in message
    assert "kept sending frames, keepalive pings or transcripts, but never audio" in message
    assert "response_timeout" in message
    assert "The idle deadline" not in message


# ---------------------------------------------------------------------------
# Tail probe after the agent has spoken
#
# Binds the "The turn ends when the agent's audio stops" group of
# ``specs/voice-receive-timeout-diagnosis.feature``, with scaled-down timings.
#
# Once the agent's audio for a turn has arrived, the drain probes with the short
# ``response_tail_silence`` timeout to find where the turn ends. Pings,
# ``vad_score``, ``context_usage`` and text parts are not speech; when they
# re-armed that probe, an agent sending them steadily never looked quiet and
# every turn ended on the 45s ceiling instead (a customer report: ~45s pause
# after every agent turn, greeting included).
# ---------------------------------------------------------------------------

TAIL_TIMEOUT = 0.10      # stand-in for response_tail_silence
QUIET_FRAME_GAP = 0.03   # < TAIL_TIMEOUT: these frames WOULD re-arm a liveness wait

QUIET_AGENT_FRAMES = [
    {"type": "ping", "ping_event": {"event_id": 7, "ping_ms": 5}},
    {"type": "vad_score", "vad_score_event": {"vad_score": 0.02}},
    {"type": "context_usage", "context_usage_event": {"used": 120}},
    {"type": "agent_chat_response_part", "text_response_part": {"text": "", "type": "stop"}},
]


def _make_scripted_ws(script: list[dict], then: dict) -> AsyncMock:
    """A mock WS that serves ``script`` frames in order, then ``then`` forever,
    each preceded by a :data:`QUIET_FRAME_GAP` sleep."""
    queue = list(script)

    async def fake_recv():
        await asyncio.sleep(QUIET_FRAME_GAP)
        return json.dumps(queue.pop(0) if queue else then)

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()
    return mock_ws


def _audio_frame() -> dict:
    return {"type": "audio", "audio_event": {"audio_base_64": base64.b64encode(b"\x12\x34" * 8).decode()}}


@pytest.mark.asyncio
@pytest.mark.timeout(5)
@pytest.mark.parametrize("frame", QUIET_AGENT_FRAMES, ids=lambda f: f["type"])
async def test_tail_probe_ends_on_audio_silence_despite_quiet_frames(monkeypatch, frame):
    """After the agent spoke, a steady stream of non-audio frames must not hold
    the tail probe open until the ceiling."""
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", 2.0)

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_scripted_ws([_audio_frame()], then=frame)

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            first = await adapter.recv_audio(timeout=1.0)
            assert first.data
            loop = asyncio.get_running_loop()
            started = loop.time()
            with pytest.raises(asyncio.TimeoutError) as excinfo:
                await adapter.recv_audio(timeout=TAIL_TIMEOUT)
            waited = loop.time() - started
        finally:
            await adapter.disconnect()

    assert f"The idle deadline of {TAIL_TIMEOUT:g}s elapsed" in str(excinfo.value)
    assert waited < 1.0, f"tail probe held open {waited:.2f}s by {frame['type']} frames"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_tail_probe_stays_open_while_agent_tool_runs(monkeypatch):
    """A server tool the agent started after speaking keeps the turn open until
    its response; the agent's next audio then arrives in the same turn."""
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", 2.0)
    ping = QUIET_AGENT_FRAMES[0]
    script = (
        [_audio_frame(), {"type": "agent_tool_request", "agent_tool_request": {"tool_name": "lookup"}}]
        + [ping] * 10  # 10 * 0.03s = 0.3s of tool time, > TAIL_TIMEOUT
        + [{"type": "agent_tool_response", "agent_tool_response": {"tool_name": "lookup"}}, _audio_frame()]
    )

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_scripted_ws(script, then=ping)

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            second = await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert second.data, "turn cut while the agent's tool was running"


TOOL_REQUEST = {"type": "agent_tool_request", "agent_tool_request": {"tool_name": "lookup"}}
TOOL_RESPONSE = {"type": "agent_tool_response", "agent_tool_response": {"tool_name": "lookup"}}


def _make_timed_ws(script: list[tuple[float, dict]], then: dict) -> AsyncMock:
    """A mock WS that serves each ``(gap_s, frame)`` after sleeping ``gap_s``,
    then ``then`` forever every :data:`QUIET_FRAME_GAP`."""
    queue = list(script)

    async def fake_recv():
        gap, frame = queue.pop(0) if queue else (QUIET_FRAME_GAP, then)
        await asyncio.sleep(gap)
        return json.dumps(frame)

    mock_ws = AsyncMock()
    mock_ws.recv = fake_recv
    mock_ws.send = AsyncMock()
    mock_ws.close = AsyncMock()
    return mock_ws


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_tail_probe_stays_open_through_a_silent_tool():
    """A tool that runs with no frames at all on the wire, longer than the tail
    probe, does not end the turn: the tool request alone holds it open."""
    script = [
        (0.0, _audio_frame()),
        (0.0, TOOL_REQUEST),
        (TAIL_TIMEOUT * 5, TOOL_RESPONSE),  # nothing on the wire while it runs
        (0.0, _audio_frame()),
    ]
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=QUIET_AGENT_FRAMES[0])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            second = await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert second.data, "silent tool cut by the tail probe"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_tail_probe_waits_for_the_post_tool_answer():
    """The spoken answer arrives later than the tail probe after the tool
    answered, with pings meanwhile. Tool completion is not speech completion,
    so the turn stays open for it."""
    ping = QUIET_AGENT_FRAMES[0]
    gap = TAIL_TIMEOUT / 3
    script = (
        [(0.0, _audio_frame()), (0.0, TOOL_REQUEST), (gap, TOOL_RESPONSE)]
        + [(gap, ping)] * 9  # 9 * gap = 3 * TAIL_TIMEOUT of answer generation
        + [(gap, _audio_frame())]
    )
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=ping)

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            answer = await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert answer.data, "turn cut before the post-tool answer"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_tail_probe_returns_once_the_post_tool_answer_started():
    """Once the post-tool answer is audible, quiet frames stop holding the turn
    open again: it ends on the tail probe."""
    script = [(0.0, _audio_frame()), (0.0, TOOL_REQUEST), (0.0, TOOL_RESPONSE), (0.0, _audio_frame())]
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=QUIET_AGENT_FRAMES[0])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            assert (await adapter.recv_audio(timeout=TAIL_TIMEOUT)).data
            loop = asyncio.get_running_loop()
            started = loop.time()
            with pytest.raises(asyncio.TimeoutError) as excinfo:
                await adapter.recv_audio(timeout=TAIL_TIMEOUT)
            waited = loop.time() - started
        finally:
            await adapter.disconnect()

    assert f"The idle deadline of {TAIL_TIMEOUT:g}s elapsed" in str(excinfo.value)
    assert waited < 1.0, f"tail probe held open {waited:.2f}s after the post-tool answer"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_post_tool_wait_is_bounded_when_the_agent_never_speaks(monkeypatch):
    """A tool answers and the agent never speaks again: the wait still ends, on
    the absolute ceiling."""
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", HARD_CEILING * 4)
    script = [(0.0, _audio_frame()), (0.0, TOOL_REQUEST), (0.0, TOOL_RESPONSE)]
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=QUIET_AGENT_FRAMES[0])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            with pytest.raises(asyncio.TimeoutError) as excinfo:
                await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert f"The absolute ceiling of {HARD_CEILING * 4:g}s elapsed" in str(excinfo.value)


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_ceiling_end_logs_the_frame_types_that_held_the_wait(monkeypatch, caplog):
    """A recv that ends on the ceiling names what kept it open."""
    # 0.27s of slack between pings (0.03s apart) and the 0.3s idle wait, so a
    # loaded host stalling the loop does not end the wait as idle instead.
    monkeypatch.setattr(elevenlabs_module, "KEEPALIVE_HARD_CEILING_S", 0.6)

    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_endless_pinging_ws()

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            with caplog.at_level("WARNING", logger="scenario.voice.elevenlabs"):
                with pytest.raises(asyncio.TimeoutError):
                    await adapter.recv_audio(timeout=0.3)
        finally:
            await adapter.disconnect()

    warnings = [r.getMessage() for r in caplog.records if "absolute ceiling" in r.getMessage()]
    assert warnings, "no ceiling warning logged"
    warning = warnings[0]
    assert "'end': 'ceiling'" in warning
    assert "'frames_by_type': {'ping':" in warning


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_tail_probe_resolves_with_more_agent_audio():
    """More agent audio inside the tail probe is the turn continuing: the probe
    returns it rather than ending the turn."""
    script = [(0.0, _audio_frame()), (TAIL_TIMEOUT / 2, _audio_frame())]
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=QUIET_AGENT_FRAMES[0])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            more = await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert more.data, "tail probe dropped the agent's next audio chunk"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_new_user_turn_lets_pings_rearm_the_wait_again():
    """After the user sends the next turn, the agent has not spoken yet, so a
    slow-but-pinging agent keeps the wait open again until it answers."""
    ping = QUIET_AGENT_FRAMES[0]
    script = (
        [(0.0, _audio_frame())]
        + [(QUIET_FRAME_GAP, ping)] * 10  # 10 * 0.03s = 3 * TAIL_TIMEOUT of pings only
        + [(QUIET_FRAME_GAP, _audio_frame())]
    )
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=ping)

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            await adapter.send_audio(AudioChunk(data=b"\x00" * 960))
            answer = await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert answer.data, "pre-response wait cut despite pings"


@pytest.mark.asyncio
@pytest.mark.timeout(5)
async def test_deadline_end_stamps_the_wait_diagnosis_on_the_receive_span():
    """A recv that ends on a deadline stamps how it ended, how long it waited,
    how late the deadline fired and the frame counts onto the active span."""
    from opentelemetry.sdk.trace import ReadableSpan, TracerProvider

    tracer = TracerProvider().get_tracer("test")
    script = [(0.0, _audio_frame())]
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _make_timed_ws(script, then=QUIET_AGENT_FRAMES[0])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        try:
            assert (await adapter.recv_audio(timeout=1.0)).data
            with tracer.start_as_current_span("voice.audio.receive") as span:
                with pytest.raises(asyncio.TimeoutError):
                    await adapter.recv_audio(timeout=TAIL_TIMEOUT)
        finally:
            await adapter.disconnect()

    assert isinstance(span, ReadableSpan)
    attrs = dict(span.attributes or {})
    waited_ms = attrs["voice.elevenlabs.receive_wait_ms"]
    late_ms = attrs["voice.elevenlabs.receive_wait_late_ms"]
    frames = attrs["voice.elevenlabs.receive_wait_frames"]
    assert attrs["voice.elevenlabs.receive_wait_end"] == "idle"
    assert isinstance(waited_ms, int) and waited_ms >= TAIL_TIMEOUT * 1000
    assert isinstance(late_ms, int) and late_ms >= 0
    assert isinstance(frames, str) and json.loads(frames)["ping"] >= 1
