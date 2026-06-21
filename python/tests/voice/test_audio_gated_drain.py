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
from unittest.mock import AsyncMock, patch

import pytest
from websockets.exceptions import ConnectionClosedOK

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


def _scripted_ws(frames: list, *, then_close: bool = False) -> AsyncMock:
    """A mock WS whose ``recv()`` serves ``frames`` in order.

    After the programmed frames are exhausted it either raises
    ``ConnectionClosedOK`` (``then_close=True``, modelling a clean server close)
    or blocks indefinitely (modelling a silent-but-open socket). The
    block-forever tail is what makes the terminal-case tests RED on an un-fixed
    adapter: without the empty-chunk return, ``recv_audio`` loops past the
    swallowed non-audio frame into the blocking ``recv()`` and only the outer
    ceiling unwinds it.
    """
    idx = 0

    async def fake_recv():
        nonlocal idx
        if idx < len(frames):
            msg = frames[idx]
            idx += 1
            return msg
        if then_close:
            raise ConnectionClosedOK(None, None)
        await asyncio.sleep(3600)  # silent-but-open socket
        raise AssertionError("unreachable")  # pragma: no cover

    ws = AsyncMock()
    ws.recv = fake_recv
    ws.send = AsyncMock()
    ws.close = AsyncMock()
    return ws


# --------------------------------------------------------------------- ElevenLabs


@pytest.mark.asyncio
async def test_elevenlabs_client_tool_call_terminates_drain():
    """A tool-only turn (``client_tool_call``, no audio) returns an empty chunk.

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
async def test_elevenlabs_socket_close_terminates_drain():
    """A clean server close mid-receive returns an empty chunk, not an error.

    Pre-fix, the unhandled ``ConnectionClosed`` propagated out of ``recv_audio``
    (the drain only catches ``asyncio.TimeoutError``) and crashed the turn.
    """
    adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="k")
    mock_ws = _scripted_ws([], then_close=True)

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
async def test_websocket_socket_close_terminates_drain():
    """Generic WebSocket: a clean server close (end of stream) returns empty.

    Pre-fix, the ``while True`` loop returned only on a decoded audio chunk and
    had no end-of-stream path, so a clean close raised an unhandled
    ``ConnectionClosed``.
    """
    adapter = WebSocketAgentAdapter(url="ws://x", protocol=_BytesAudioProtocol())
    mock_ws = _scripted_ws([], then_close=True)

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
