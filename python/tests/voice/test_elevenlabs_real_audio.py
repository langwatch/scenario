"""
Issue #705 — REAL voice-in multi-turn on hosted ElevenLabs ConvAI.

Python parity with
``javascript/src/voice/adapters/__tests__/elevenlabs-real-audio.test.ts``.

Real-audio streaming is the adapter's ONLY behavior: ``send_audio`` streams the
user's REAL spoken PCM as a ``{"user_audio_chunk": …}`` frame (then a trailing
silence tail that trips EL's end-of-turn detector), and NEVER injects a
``{"type": "user_message", "text": …}`` text commit. The old text-commit default
discarded the PCM, so EL's STT/VAD/turn-taking never ran on scripted turns 2+ —
that was the #705 bug; the text-commit path is gone.

These two regression guards drive the adapter through an injected fake WebSocket
(patching ``websockets.connect``, the same seam the EL transport tests use) and
prove, without a live EL socket:
 1. across a greeting-led >=2-turn drive, turn 2 streams the REAL PCM speech as a
    ``user_audio_chunk`` and emits NO ``user_message`` text commit;
    ``audio_commit_count >= 2``.
 2. the #705 STT assertion — after EL returns a ``user_transcript``,
    ``last_user_transcript`` is truthy and ``audio_commit_count >= 2``, i.e. real
    audio reached the agent (strictly stronger than #596's ``>=N segments``).

Offline — no network, no real EL socket. The LIVE >=2-exchange proof lives in
``examples/voice/elevenlabs_hosted.py`` (wrapped by
``test_elevenlabs_hosted_e2e.py``).
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter


class FakeElevenLabsSocket:
    """Minimal in-memory EL ConvAI WebSocket.

    Records every frame the adapter sends and lets the test push inbound frames
    on demand via :meth:`deliver` / :meth:`deliver_audio`. ``recv`` blocks on an
    :class:`asyncio.Queue` so a test can interleave ``send_audio`` and
    ``recv_audio`` across multiple turns the way the executor does.
    """

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbound: "asyncio.Queue[str]" = asyncio.Queue()
        self.closed = False

    # ----- transport surface the adapter uses -----

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:
        return await self._inbound.get()

    async def close(self) -> None:
        self.closed = True

    # ----- test drivers -----

    def deliver(self, event: dict[str, Any]) -> None:
        """Queue a raw inbound JSON frame for the adapter to recv."""
        self._inbound.put_nowait(json.dumps(event))

    def deliver_audio(self, byte_len: int = 4) -> None:
        """Queue an ``audio`` event carrying ``byte_len`` bytes of PCM16."""
        pcm = b"\x01" * byte_len
        self.deliver(
            {
                "type": "audio",
                "audio_event": {"audio_base_64": base64.b64encode(pcm).decode()},
            }
        )

    # ----- parsed views of what the adapter sent -----

    @property
    def sent_parsed(self) -> list[dict[str, Any]]:
        return [json.loads(s) for s in self.sent]

    @property
    def user_messages(self) -> list[dict[str, Any]]:
        """Frames that are ``user_message`` turn-commits (must always be empty)."""
        return [m for m in self.sent_parsed if m.get("type") == "user_message"]

    @property
    def audio_chunks(self) -> list[str]:
        """Base64 payloads of every ``user_audio_chunk`` frame (speech or silence)."""
        return [
            m["user_audio_chunk"]
            for m in self.sent_parsed
            if isinstance(m.get("user_audio_chunk"), str)
        ]


async def _connected_adapter() -> tuple[ElevenLabsAgentAdapter, FakeElevenLabsSocket]:
    """Build an adapter wired to a fresh fake socket, already connected.

    Real-audio streaming is the only behavior — there is no turn-commit mode to
    select.
    """
    socket = FakeElevenLabsSocket()
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test")
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    return adapter, socket


def _real_speech_turn(text: str) -> AudioChunk:
    """A user turn carrying NON-SILENT PCM — stands in for real spoken audio,
    distinguishable from the zero-byte silence tail."""
    return AudioChunk(data=b"\x10\x00\x20\x00\x30\x00\x40\x00", transcript=text)


def _is_real_speech(b64: str) -> bool:
    """True if a base64 user_audio_chunk carries any non-zero (speech) bytes."""
    return any(byte != 0 for byte in base64.b64decode(b64))


@pytest.mark.asyncio
async def test_real_audio_streams_real_pcm_on_turns_2plus_no_user_message():
    """Turn 2 streams the REAL speech PCM as a ``user_audio_chunk`` and sends NO
    ``user_message`` text commit — so EL's STT runs on the scripted audio (the
    #705 fix). Parity with elevenlabs-real-audio.test.ts."""
    adapter, socket = await _connected_adapter()

    # Greeting drains (real-voice convention).
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    # Turn 1: user speaks, agent replies.
    await adapter.send_audio(_real_speech_turn("Hi, a question about my balance."))
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    # Turn 2 — the #705 bug turn. Snapshot the send boundary to isolate it.
    sent_before = len(socket.sent)
    await adapter.send_audio(_real_speech_turn("What are your support hours?"))
    turn2 = socket.sent_parsed[sent_before:]

    # Turn 2 streamed the real spoken PCM as a user_audio_chunk …
    real_speech = [
        m
        for m in turn2
        if isinstance(m.get("user_audio_chunk"), str) and _is_real_speech(m["user_audio_chunk"])
    ]
    assert real_speech, "the adapter must stream real PCM on turn 2"
    # … and injected NO user_message text commit (the #705 bug).
    assert [m for m in turn2 if m.get("type") == "user_message"] == []
    # Both user turns were audio commits.
    assert adapter.audio_commit_count >= 2


@pytest.mark.asyncio
async def test_stt_assertion_holds_after_user_transcript():
    """AC4 parity: after EL returns a ``user_transcript`` for the streamed PCM,
    the STT assertion holds — ``last_user_transcript`` is truthy and both user
    turns were committed as real audio (strictly stronger than #596's
    ``>=N segments``, which passed on the old text-commit path)."""
    adapter, socket = await _connected_adapter()

    # Two real-audio user turns.
    await adapter.send_audio(_real_speech_turn("turn one"))
    await adapter.send_audio(_real_speech_turn("turn two"))

    # EL's STT output for the PCM we streamed, then audio so recv_audio returns.
    socket.deliver(
        {"type": "user_transcript", "user_transcription_event": {"user_transcript": "turn two"}}
    )
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    assert adapter.last_user_transcript, "expected an STT user_transcript"
    assert adapter.audio_commit_count >= 2
