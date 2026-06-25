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


def _real_speech_turn(text: str) -> AudioChunk:
    """A user turn carrying NON-SILENT PCM — stands in for real spoken audio,
    distinguishable from the zero-byte silence tail."""
    return AudioChunk(data=b"\x10\x00\x20\x00\x30\x00\x40\x00", transcript=text)


def _is_real_speech(b64: str) -> bool:
    """True if a base64 user_audio_chunk carries any non-zero (speech) bytes."""
    return any(byte != 0 for byte in base64.b64decode(b64))


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


# --------------------------------------------------------------------------- #
# Real-audio turn-commit ("audio") — issue #705 (TS parity)                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_audio_mode_streams_real_pcm_on_turns_2plus_no_user_message():
    """``turn_commit_mode="audio"`` streams REAL speech PCM for turns 2+ and
    sends NO user_message text commit — so EL's STT runs on the scripted audio
    (the #705 fix). Parity with elevenlabs-real-audio.test.ts."""
    adapter, socket = await _connected_adapter(turn_commit_mode="audio")

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
    assert real_speech, "audio mode must stream real PCM on turn 2"
    # … and injected NO user_message text commit.
    assert [m for m in turn2 if m.get("type") == "user_message"] == []
    # Counters: both user turns were audio commits, none text-injected.
    assert adapter.audio_commit_count >= 2
    assert adapter.text_commit_count == 0


@pytest.mark.asyncio
async def test_stt_driven_assertion_holds_for_audio_mode_and_fails_for_text():
    """AC4 parity: the STT-driven predicate (no text injection + audio committed
    + a transcript) holds for audio mode and MUST FAIL on the text-commit path,
    which only echoes injected text back (the #596 `>=N segments` gap)."""

    def stt_driven(adapter: ElevenLabsAgentAdapter) -> bool:
        return (
            adapter.text_commit_count == 0
            and adapter.audio_commit_count >= 2
            and bool(adapter.last_user_transcript)
        )

    # audio mode: real audio → EL returns an STT transcript → predicate TRUE.
    a_adapter, a_socket = await _connected_adapter(turn_commit_mode="audio")
    await a_adapter.send_audio(_real_speech_turn("turn one"))
    await a_adapter.send_audio(_real_speech_turn("turn two"))
    a_socket.deliver(
        {"type": "user_transcript", "user_transcription_event": {"user_transcript": "turn two"}}
    )
    a_socket.deliver_audio()
    await a_adapter.recv_audio(timeout=1.0)
    assert stt_driven(a_adapter) is True

    # text mode: transcript is an echo of injected text, not STT → predicate FALSE.
    t_adapter, t_socket = await _connected_adapter()  # default "text"
    await t_adapter.send_audio(_user_turn("turn one"))
    await t_adapter.send_audio(_user_turn("turn two"))
    t_socket.deliver(
        {"type": "user_transcript", "user_transcription_event": {"user_transcript": "turn two"}}
    )
    t_socket.deliver_audio()
    await t_adapter.recv_audio(timeout=1.0)
    assert stt_driven(t_adapter) is False


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
