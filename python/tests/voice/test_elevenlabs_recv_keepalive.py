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
