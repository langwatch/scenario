"""
Issue #648 — audio-gated drain must terminate cleanly on a non-audio completion.

The ElevenLabs (hosted ConvAI) and generic WebSocket adapters share an
audio-gated receive loop: historically each returned ONLY on an audio frame, so
a turn that completed WITHOUT producing audio drained to the ``response_timeout``
deadline and raised (a latent hang surfaced by ``/sweep`` during PR #647, which
fixed the same anti-pattern in the OpenAI Realtime adapter for issue #646).

The fix mirrors the #646/PR647 reference pattern (and the Gemini Live /
Pipecat idiom): on a non-audio terminal — a socket close, or an ElevenLabs
``client_tool_call`` (a tool-only turn that never yields spoken audio because
this adapter has no ``client_tool_result`` path) — ``recv_audio`` returns an
**empty** ``AudioChunk`` so the base ``_drain_agent_response`` loop exits
cleanly instead of hanging.

These tests pin that behaviour and guard against regressing the normal
audio path. No real network: ``websockets.connect`` is patched to a mock whose
``recv()`` serves programmed frames (or raises ``ConnectionClosedOK`` to model a
clean server close).

Each terminal-case assertion gives ``recv_audio`` a generous ``timeout`` (the
budget it would otherwise hang for) and wraps the call in a short outer
``asyncio.wait_for`` ceiling, so an un-fixed adapter that loops to its deadline
fails fast instead of stalling the suite — the empty-chunk fix returns
immediately and stays well under the ceiling.
"""

import asyncio
import base64
import json
from typing import Optional
from unittest.mock import AsyncMock, patch

import pytest
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from scenario.voice import AudioChunk, ElevenLabsAgentAdapter
from scenario.voice.adapters.websocket import (
    WebSocketAgentAdapter,
    WebSocketProtocol,
)


# recv_audio is handed a long nominal budget (what an un-fixed adapter would
# hang for); the outer ceiling fails the test fast if the empty-chunk terminal
# is missing. The fix returns instantly, far under the ceiling.
RECV_TIMEOUT = 30.0
OUTER_CEILING = 2.0


def _scripted_ws(frames: list, *, close_with: Optional[Exception] = None) -> AsyncMock:
    """A mock WS whose ``recv()`` serves ``frames`` in order.

    After the programmed frames are exhausted it either raises ``close_with`` (a
    ``ConnectionClosed*`` instance, modelling a server close) or — when
    ``close_with is None`` — blocks indefinitely (modelling a silent-but-open
    socket). The block-forever tail is what makes the terminal-case tests RED on
    an un-fixed adapter: without the empty-chunk return, ``recv_audio`` loops
    past the swallowed non-audio frame into the blocking ``recv()`` and only the
    outer ceiling unwinds it.
    """
    idx = 0

    async def fake_recv():
        nonlocal idx
        if idx < len(frames):
            msg = frames[idx]
            idx += 1
            return msg
        if close_with is not None:
            raise close_with
        await asyncio.sleep(3600)  # silent-but-open socket
        raise AssertionError("unreachable")  # pragma: no cover

    ws = AsyncMock()
    ws.recv = fake_recv
    ws.send = AsyncMock()
    ws.close = AsyncMock()
    return ws


# Production catches the base ``ConnectionClosed``; both a clean close
# (``ConnectionClosedOK``) and an abnormal one (``ConnectionClosedError``) must
# terminate the drain cleanly, so the socket-close tests run against both.
_CLOSE_CLASSES = [ConnectionClosedOK, ConnectionClosedError]


# --------------------------------------------------------------------- ElevenLabs


@pytest.mark.asyncio
async def test_elevenlabs_client_tool_call_returns_empty_chunk():
    """Unit: a tool-only turn (``client_tool_call``, no audio) returns empty.

    EL ConvAI emits ``client_tool_call`` when the agent invokes a client-side
    tool. This adapter never sends ``client_tool_result``, so the agent produces
    no spoken audio for the turn — pre-fix, ``recv_audio`` swallowed the event
    and looped to the deadline. The fix surfaces the completion as an empty
    ``AudioChunk``.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    tool_call = json.dumps(
        {
            "type": "client_tool_call",
            "client_tool_call": {
                "tool_name": "lookup_order",
                "tool_call_id": "call_1",
                "parameters": {"order_id": "42"},
            },
        }
    )
    mock_ws = _scripted_ws([tool_call])  # then blocks forever

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await asyncio.wait_for(
            adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
        )

    assert isinstance(result, AudioChunk)
    assert result.data == b""  # empty terminal, not a hang


@pytest.mark.asyncio
@pytest.mark.parametrize("close_cls", _CLOSE_CLASSES)
async def test_elevenlabs_socket_close_returns_empty_chunk(close_cls):
    """Unit: a server close mid-receive returns an empty chunk, not an error.

    Runs against both a clean close (``ConnectionClosedOK``) and an abnormal one
    (``ConnectionClosedError``): production catches the base ``ConnectionClosed``,
    so both subclasses must terminate the drain cleanly. Pre-fix, the unhandled
    ``ConnectionClosed`` propagated out of ``recv_audio`` (the drain only catches
    ``asyncio.TimeoutError``) and crashed the turn.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _scripted_ws([], close_with=close_cls(None, None))

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await asyncio.wait_for(
            adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
        )

    assert isinstance(result, AudioChunk)
    assert result.data == b""


@pytest.mark.asyncio
async def test_elevenlabs_normal_audio_still_returned():
    """No regression: a normal ``audio`` frame is still decoded and returned."""
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    pcm_payload = b"\x12\x34" * 8  # 16 bytes of dummy PCM16
    b64 = base64.b64encode(pcm_payload).decode()
    audio_frame = json.dumps({"type": "audio", "audio_event": {"audio_base_64": b64}})
    mock_ws = _scripted_ws([audio_frame])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await asyncio.wait_for(
            adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
        )

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_payload  # real audio, non-empty


@pytest.mark.asyncio
async def test_elevenlabs_tool_only_turn_drain_exits_cleanly():
    """Drain-level: a tool-only turn makes ``_drain_agent_response`` exit cleanly.

    This is the end-to-end guard for the bug as reported — a *drain*-level hang —
    above the unit tests that pin ``recv_audio`` alone. With a ``client_tool_call``
    and no audio: the first ``recv_audio`` returns an empty chunk; the drain marks
    no first-chunk, enters its tail loop, and breaks on the next recv (the now-
    silent socket times out at ``response_tail_silence``), returning an empty
    merged turn. Pre-fix, the first ``recv_audio`` looped to ``response_timeout``
    and the drain raised :class:`FirstChunkTimeoutError`.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    # After the empty first chunk the drain does one more recv that must time out
    # fast against the now-silent socket — keep the tail-silence wait tiny.
    adapter.response_tail_silence = 0.1
    tool_call = json.dumps(
        {
            "type": "client_tool_call",
            "client_tool_call": {
                "tool_name": "lookup_order",
                "tool_call_id": "call_1",
                "parameters": {},
            },
        }
    )
    mock_ws = _scripted_ws([tool_call])  # then blocks (silent-but-open) socket

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        merged = await asyncio.wait_for(
            adapter._drain_agent_response(), timeout=OUTER_CEILING
        )

    # Drain returned an empty merged turn instead of raising FirstChunkTimeoutError.
    assert isinstance(merged, AudioChunk)
    assert merged.data == b""


# ----------------------------------------------------------------- WebSocket (generic)


class _BytesAudioProtocol(WebSocketProtocol):
    """Minimal protocol: binary frames are PCM16 audio; everything else is non-audio."""

    def encode_audio(self, audio: bytes):
        return audio

    def decode_response(self, message):
        if isinstance(message, (bytes, bytearray)):
            return AudioChunk(data=bytes(message))
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize("close_cls", _CLOSE_CLASSES)
async def test_websocket_socket_close_returns_empty_chunk(close_cls):
    """Unit: generic WebSocket server close (end of stream) returns empty.

    Runs against both clean (``ConnectionClosedOK``) and abnormal
    (``ConnectionClosedError``) closes. Pre-fix, the ``while True`` loop returned
    only on a decoded audio chunk and had no end-of-stream path, so a close
    raised an unhandled ``ConnectionClosed``.
    """
    adapter = WebSocketAgentAdapter(url="ws://x", protocol=_BytesAudioProtocol())
    mock_ws = _scripted_ws([], close_with=close_cls(None, None))

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await asyncio.wait_for(
            adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
        )

    assert isinstance(result, AudioChunk)
    assert result.data == b""


@pytest.mark.asyncio
async def test_websocket_normal_audio_still_returned():
    """No regression: a decoded audio frame is still returned from the loop."""
    adapter = WebSocketAgentAdapter(url="ws://x", protocol=_BytesAudioProtocol())
    pcm_payload = b"\xab\xcd" * 8
    mock_ws = _scripted_ws([pcm_payload])

    with patch("websockets.connect", new=AsyncMock(return_value=mock_ws)):
        await adapter.connect()
        result = await asyncio.wait_for(
            adapter.recv_audio(timeout=RECV_TIMEOUT), timeout=OUTER_CEILING
        )

    assert isinstance(result, AudioChunk)
    assert result.data == pcm_payload
