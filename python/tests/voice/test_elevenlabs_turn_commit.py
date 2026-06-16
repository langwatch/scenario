"""
Issue #567 — ElevenLabs ConvAI scripted next-turn / post-interrupt receive.

Python parity with ``javascript/src/voice/__tests__/elevenlabs-turn-commit.test.ts``.

The hosted ConvAI transport has NO audio end-of-turn client event (verified
against the official EL Python + JS SDKs), so the pre-#567 adapter leaned on a
fixed silence tail to coax server-side VAD. That tail does not reliably
re-engage a response for a scripted turn 2+ (EL ConvAI 2.0 end-of-turn is a
hybrid VAD + deep-learning turn-detector, not a pure silence threshold), so the
2nd ``recv_audio`` timed out.

The fix sends an explicit ``{"type": "user_message", "text": <transcript>}``
turn-commit — the only documented client→server event that deterministically
forces an agent response without mic-style VAD. On the text path the raw audio
is NOT also streamed to EL (audio + text in one turn raced the server's
ingestion and was live-flaky); the user audio is still recorded locally by the
voice runtime and EL echoes the text back as a ``user_transcript`` event.

These tests drive the adapter through an injected fake WebSocket (patching
``websockets.connect``, the same seam the existing EL transport tests use) and
prove:
 1. a scripted 2nd user turn after an agent turn drives a 2nd ``recv_audio``
    resolution (the bug), AND each user turn emits a ``user_message`` commit;
 2. the post-interrupt shape (agent audio mid-flight → user re-engages) also
    commits + re-engages, and ``agent_response_correction`` updates the
    transcript;
 3. the committed ``user_message`` is a server-accepted shape (type + text);
 4. ``turn_commit_mode="silence"`` preserves the legacy pure-audio path;
 5. ``"text"`` mode with no transcript falls back to the silence tail;
 6. ``silence_tail_bytes`` resizes the fallback tail.

Offline — no network, no real EL socket. The LIVE >=2-exchange proof lives in
``examples/voice/elevenlabs_hosted.py`` (wrapped by
``test_elevenlabs_hosted_e2e.py``).
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any, Optional
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter


class FakeElevenLabsSocket:
    """Minimal in-memory EL ConvAI WebSocket.

    Records every frame the adapter sends and lets the test push inbound
    frames on demand via :meth:`deliver` / :meth:`deliver_audio`. ``recv``
    blocks on an :class:`asyncio.Queue` so a test can interleave ``send_audio``
    and ``recv_audio`` across multiple turns the way the executor does.
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
        """Frames that are ``user_message`` turn-commits."""
        return [m for m in self.sent_parsed if m.get("type") == "user_message"]

    @property
    def audio_chunks(self) -> list[str]:
        """Base64 payloads of every ``user_audio_chunk`` frame (speech or silence)."""
        return [
            m["user_audio_chunk"]
            for m in self.sent_parsed
            if isinstance(m.get("user_audio_chunk"), str)
        ]


async def _connected_adapter(
    *,
    turn_commit_mode: str = "text",
    silence_tail_bytes: Optional[int] = None,
) -> tuple[ElevenLabsAgentAdapter, FakeElevenLabsSocket]:
    """Build an adapter wired to a fresh fake socket, already connected."""
    socket = FakeElevenLabsSocket()
    kwargs: dict[str, Any] = {"turn_commit_mode": turn_commit_mode}
    if silence_tail_bytes is not None:
        kwargs["silence_tail_bytes"] = silence_tail_bytes
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test", **kwargs)
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    return adapter, socket


def _user_turn(text: str) -> AudioChunk:
    """A user audio chunk that carries its transcript (as the voice runtime threads it)."""
    return AudioChunk(data=b"\x00" * 8, transcript=text)


# --------------------------------------------------------------------------- #
# Text turn-commit (default) — the #567 fix                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_scripted_second_user_turn_drives_second_recv_audio():
    """The BUG case: a scripted 2nd user turn re-engages a 2nd agent response."""
    adapter, socket = await _connected_adapter()

    # ---- Exchange 1: greeting drains (real-voice convention) ----
    socket.deliver_audio()
    greeting = await adapter.recv_audio(timeout=1.0)
    assert len(greeting.data) > 0

    # ---- Exchange 1: user turn 1 -> agent responds ----
    await adapter.send_audio(_user_turn("Hello, I have a question about my account."))
    socket.deliver_audio()
    agent1 = await adapter.recv_audio(timeout=1.0)
    assert len(agent1.data) > 0

    # ---- Exchange 2: the BUG case — scripted 2nd user turn ----
    await adapter.send_audio(_user_turn("Yes, can you check my balance?"))
    socket.deliver_audio()
    # This resolving (not raising TimeoutError) is the #567 proof.
    agent2 = await adapter.recv_audio(timeout=1.0)
    assert len(agent2.data) > 0

    # Each user turn emitted an explicit user_message turn-commit (not a
    # silence tail) — the deterministic re-engagement signal.
    assert socket.user_messages == [
        {"type": "user_message", "text": "Hello, I have a question about my account."},
        {"type": "user_message", "text": "Yes, can you check my balance?"},
    ]
    # The default "text" path sends ONLY the text commit — NO user_audio_chunk
    # frames at all (audio + text in one turn raced EL's ingestion and was
    # live-flaky; the text turn alone re-engages deterministically).
    assert socket.audio_chunks == []


@pytest.mark.asyncio
async def test_post_interrupt_user_turn_re_engages_and_correction_updates_transcript():
    """A user turn after partial agent audio re-engages a fresh (corrected) response."""
    adapter, socket = await _connected_adapter()

    # Agent starts talking (turn 1 audio); executor barges in.
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    # User interrupts/responds with a new scripted turn.
    await adapter.send_audio(_user_turn("Actually, wait — cancel that."))
    # EL issues an agent_response_correction (post-barge-in), then fresh audio.
    socket.deliver(
        {
            "type": "agent_response_correction",
            "agent_response_correction_event": {
                "original_agent_response": "Sure, your balance is…",
                "corrected_agent_response": "Okay, cancelled.",
            },
        }
    )
    socket.deliver_audio()
    corrected = await adapter.recv_audio(timeout=1.0)

    assert len(corrected.data) > 0
    assert adapter.last_agent_transcript == "Okay, cancelled."
    assert socket.user_messages == [
        {"type": "user_message", "text": "Actually, wait — cancel that."}
    ]


@pytest.mark.asyncio
async def test_user_message_commit_echoes_through_as_user_transcript():
    """EL echoes the committed text back as user_transcript observability."""
    adapter, socket = await _connected_adapter()

    await adapter.send_audio(_user_turn("What are your hours?"))
    socket.deliver(
        {
            "type": "user_transcript",
            "user_transcription_event": {"user_transcript": "What are your hours?"},
        }
    )
    socket.deliver_audio()  # let recv_audio return after consuming the transcript
    await adapter.recv_audio(timeout=1.0)

    assert adapter.last_user_transcript == "What are your hours?"


@pytest.mark.asyncio
async def test_committed_user_message_is_server_accepted_shape():
    """The committed user_message carries exactly ``type`` + ``text``."""
    adapter, socket = await _connected_adapter()

    await adapter.send_audio(_user_turn("ping"))

    commit = socket.user_messages[0]
    assert sorted(commit.keys()) == ["text", "type"]
    assert commit["type"] == "user_message"
    assert commit["text"] == "ping"


# --------------------------------------------------------------------------- #
# Silence-tail fallbacks                                                       #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_silence_mode_preserves_legacy_pure_audio_path():
    """``turn_commit_mode="silence"`` keeps the legacy audio + silence-tail path."""
    adapter, socket = await _connected_adapter(turn_commit_mode="silence")

    await adapter.send_audio(_user_turn("Hello again."))

    # Legacy path: speech chunk + a zero-byte silence tail, NO user_message.
    assert socket.user_messages == []
    silence_tail = base64.b64encode(b"\x00" * 16000).decode()
    assert silence_tail in socket.audio_chunks
    assert len(socket.audio_chunks) == 2  # speech + silence


@pytest.mark.asyncio
async def test_text_mode_without_transcript_falls_back_to_silence_tail():
    """``"text"`` mode with no transcript falls back to the silence tail."""
    adapter, socket = await _connected_adapter()  # default "text"

    # No transcript on the chunk (e.g. raw audio with no STT text upstream).
    await adapter.send_audio(AudioChunk(data=b"\x00" * 8))

    assert socket.user_messages == []
    silence_tail = base64.b64encode(b"\x00" * 16000).decode()
    assert silence_tail in socket.audio_chunks


@pytest.mark.asyncio
async def test_silence_tail_bytes_resizes_the_fallback_tail():
    """``silence_tail_bytes`` resizes the legacy fallback tail."""
    adapter, socket = await _connected_adapter(
        turn_commit_mode="silence", silence_tail_bytes=2400
    )

    await adapter.send_audio(_user_turn("size me"))

    expected_tail = base64.b64encode(b"\x00" * 2400).decode()
    assert expected_tail in socket.audio_chunks
    assert base64.b64encode(b"\x00" * 16000).decode() not in socket.audio_chunks


@pytest.mark.asyncio
async def test_silence_mode_second_turn_times_out_without_user_message_commit():
    """The pre-#567 bug: silence mode emits no user_message commit.

    When server-side VAD does not fire on the scripted non-mic stream (EL
    ConvAI 2.0 hybrid VAD + DL turn-detector), no agent audio arrives and
    ``recv_audio`` times out. This is the NEGATIVE counterexample that proves
    the fix is necessary: the default ``"text"`` path (issue #567 fix) avoids
    this stall by sending an explicit ``user_message`` commit.
    """
    adapter, socket = await _connected_adapter(turn_commit_mode="silence")

    # Greeting.
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    # Turn 1: user sends, manually deliver agent audio (simulating VAD firing).
    await adapter.send_audio(_user_turn("Hello."))
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    # Turn 2: silence mode — no user_message emitted.
    # We do NOT call socket.deliver_audio() — simulating the production stall
    # where server VAD doesn't fire on the scripted non-mic stream.
    await adapter.send_audio(_user_turn("What are my options?"))

    # Confirm: silence path sends NO user_message commit.
    assert socket.user_messages == []

    # Without a commit, the server never re-engages → recv_audio times out.
    with pytest.raises(asyncio.TimeoutError):
        await adapter.recv_audio(timeout=0.01)


# ------------------------------------------------------------------ constructor validation


def test_rejects_unknown_turn_commit_mode():
    with pytest.raises(ValueError, match="Unknown turn_commit_mode"):
        ElevenLabsAgentAdapter(agent_id="x", api_key="y", turn_commit_mode="vad")  # type: ignore[arg-type]  # intentionally invalid value to test runtime validation


def test_rejects_zero_silence_tail_bytes():
    with pytest.raises(ValueError, match="positive integer"):
        ElevenLabsAgentAdapter(agent_id="x", api_key="y", silence_tail_bytes=0)


def test_rejects_negative_silence_tail_bytes():
    with pytest.raises(ValueError, match="positive integer"):
        ElevenLabsAgentAdapter(agent_id="x", api_key="y", silence_tail_bytes=-1)
