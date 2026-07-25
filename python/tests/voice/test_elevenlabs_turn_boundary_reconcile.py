"""
Issue #749 — split-utterance bleed at the user-turn boundary (Python parity
with the TypeScript fix in #748).

The drain closes an agent turn on ``response_tail_silence``. ElevenLabs delivers
audio in bursts, so a mid-utterance delivery gap longer than that silence ends
the turn while the agent is still speaking. Pre-fix, the remainder was read by
the NEXT drain and surfaced as the next agent turn's opening audio — turn N+1
appearing to answer question N. Observed live: a two-turn hosted run where the
agent's reply to "can you tell me your support hours?" was its reply to the
PREVIOUS question.

The reconcile runs at the pre-user-``send_audio`` boundary, where the agent
cannot have begun its next reply, so anything still arriving is unambiguously
the prior turn's tail.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter
from scenario.voice.adapter import reconcile_prior_agent_audio
from scenario.voice.recording import AudioSegment


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbound: "asyncio.Queue[str]" = asyncio.Queue()
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:
        return await self._inbound.get()

    async def close(self) -> None:
        self.closed = True

    def deliver_audio(self, payload: bytes) -> None:
        self._inbound.put_nowait(
            json.dumps(
                {
                    "type": "audio",
                    "audio_event": {"audio_base_64": base64.b64encode(payload).decode()},
                }
            )
        )


class FakeRecording:
    def __init__(self, segments: list[AudioSegment]) -> None:
        self.segments = segments


class FakeExecutor:
    def __init__(self, segments: list[AudioSegment]) -> None:
        self._voice_recording = FakeRecording(segments)
        self.fired: list[AudioChunk] = []

    def _on_audio_chunk(self, chunk: AudioChunk) -> None:
        self.fired.append(chunk)


async def _connected() -> tuple[ElevenLabsAgentAdapter, FakeSocket]:
    socket = FakeSocket()
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    await adapter.stop_pump()
    return adapter, socket


def _agent_segment(audio: bytes = b"\x01" * 100) -> AudioSegment:
    return AudioSegment(
        speaker="agent", start_time=1.0, end_time=2.0, audio=audio, transcript="head only"
    )


def _user_segment() -> AudioSegment:
    return AudioSegment(
        speaker="user", start_time=2.0, end_time=3.0, audio=b"\x02" * 10, transcript="hi"
    )


# --------------------------------------------------------------------------- #
# Collecting the stranded audio                                                #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_reconcile_collects_audio_still_in_flight():
    adapter, socket = await _connected()
    socket.deliver_audio(b"\x11" * 40)
    socket.deliver_audio(b"\x22" * 60)

    leftover = await adapter.reconcile_pending_audio()

    assert leftover is not None
    assert leftover.data == b"\x11" * 40 + b"\x22" * 60


@pytest.mark.asyncio
async def test_reconcile_returns_none_when_nothing_is_in_flight():
    adapter, _socket = await _connected()

    assert await adapter.reconcile_pending_audio() is None


@pytest.mark.asyncio
async def test_reconcile_is_bounded_and_does_not_stall_the_turn():
    """A silent-but-alive socket must not hold the turn boundary open."""
    adapter, _socket = await _connected()

    loop = asyncio.get_running_loop()
    start = loop.time()
    await adapter.reconcile_pending_audio()

    assert loop.time() - start < 1.0


@pytest.mark.asyncio
async def test_reconcile_on_a_disconnected_adapter_is_a_noop():
    adapter, _socket = await _connected()
    await adapter.disconnect()

    assert await adapter.reconcile_pending_audio() is None


# --------------------------------------------------------------------------- #
# Attribution                                                                  #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_stranded_audio_grows_the_preceding_agent_segment():
    """Cursor-safe: an agent segment is still last, so the tail goes back onto
    the utterance that produced it instead of bleeding into the next turn."""
    adapter, socket = await _connected()
    prior = _agent_segment()
    executor = FakeExecutor([prior])
    socket.deliver_audio(b"\x33" * 50)

    await reconcile_prior_agent_audio(adapter, executor, now=4.0)

    assert prior.audio == b"\x01" * 100 + b"\x33" * 50
    assert prior.end_time == 4.0
    # Cleared so the finalize STT back-fill re-transcribes the longer audio —
    # the old transcript covered only the head.
    assert prior.transcript is None
    # Routed through the audio-chunk hook like every other recorded agent chunk.
    assert [c.data for c in executor.fired] == [b"\x33" * 50]


@pytest.mark.asyncio
async def test_end_time_never_moves_backwards():
    adapter, socket = await _connected()
    prior = _agent_segment()
    prior.end_time = 9.0
    executor = FakeExecutor([prior])
    socket.deliver_audio(b"\x44" * 10)

    await reconcile_prior_agent_audio(adapter, executor, now=4.0)

    assert prior.end_time == 9.0


@pytest.mark.asyncio
async def test_cursor_unsafe_drops_rather_than_corrupting_the_cursor():
    """A user segment is last (barge-in shape): the audio is already off the
    wire so it cannot bleed, but growing an out-of-order segment would corrupt
    the append-only cursor. Drop it."""
    adapter, socket = await _connected()
    user_seg = _user_segment()
    executor = FakeExecutor([_agent_segment(), user_seg])
    socket.deliver_audio(b"\x55" * 30)

    await reconcile_prior_agent_audio(adapter, executor, now=4.0)

    assert user_seg.audio == b"\x02" * 10, "the user segment is untouched"
    assert executor.fired == [], "dropped audio is not recorded"


@pytest.mark.asyncio
async def test_no_recording_is_tolerated():
    """The opening greeting has no prior segment at all."""
    adapter, socket = await _connected()
    executor = FakeExecutor([])
    socket.deliver_audio(b"\x66" * 20)

    await reconcile_prior_agent_audio(adapter, executor, now=4.0)

    assert executor.fired == []


@pytest.mark.asyncio
async def test_adapters_without_the_hook_are_untouched():
    """Duck-typed: adapters with no buffered audio expose no such method."""

    class Bare:
        pass

    executor = FakeExecutor([_agent_segment()])

    await reconcile_prior_agent_audio(Bare(), executor, now=4.0)

    assert executor.fired == []


@pytest.mark.asyncio
async def test_a_raising_reconcile_never_fails_the_turn():
    class Exploding:
        async def reconcile_pending_audio(self) -> Any:
            raise RuntimeError("transport blew up")

    executor = FakeExecutor([_agent_segment()])

    await reconcile_prior_agent_audio(Exploding(), executor, now=4.0)

    assert executor.fired == []
