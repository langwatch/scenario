"""
In-process loopback test proving the Twilio Media Streams wire protocol is
symmetric — bytes sent by adapter A's ``send_audio`` surface at adapter B's
``recv_audio`` after round-tripping through frame encode/decode and µ-law/PCM
conversion. No real Twilio, no cloudflared, no money spent.

The real two-number PSTN smoke lives in
``examples/voice/twilio_outbound.py``; this test is its
fast, free, deterministic sibling that runs in CI.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
import pytest

from scenario.voice import AudioChunk, TwilioAgentAdapter


def _make_adapter(port: int) -> TwilioAgentAdapter:
    return TwilioAgentAdapter(
        account_sid="AC" + "0" * 32,
        auth_token="secret",
        phone_number=f"+1415555{port:04d}",
        public_base_url=f"https://example{port}.trycloudflare.com",
        http_port=port,
    )


class _BridgedWebSocket:
    """Minimal starlette-compatible WebSocket double that pipes frames
    between two adapter sides via asyncio.Queues.

    - ``send_text`` pushes onto the outbound queue (what this side emits)
    - ``receive_text`` pops from the inbound queue (what the other side emitted)
    """

    def __init__(self, inbound: asyncio.Queue[str], outbound: asyncio.Queue[str]) -> None:
        self._inbound = inbound
        self._outbound = outbound

    async def send_text(self, text: str) -> None:
        await self._outbound.put(text)

    async def receive_text(self) -> str:
        return await self._inbound.get()


async def _drive_loop(adapter: TwilioAgentAdapter, ws: _BridgedWebSocket, stream_sid: str) -> asyncio.Task:
    """Install wiring on the adapter, simulating what `_stream()` does for a
    real Twilio WS connection:
      - set `_stream_ws` so send_audio has something to write to
      - set `_stream_sid` so it can address outbound frames
      - fire `_stream_connected` so place_call/wait_for_call would return
      - kick off `_media_stream_loop(ws)` in a background task
    """
    adapter._stream_ws = ws
    adapter._stream_sid = stream_sid
    assert adapter._stream_connected is not None
    adapter._stream_connected.set()
    return asyncio.create_task(adapter._media_stream_loop(ws))


def _start_frame(stream_sid: str, call_sid: str) -> str:
    """The handshake frame Twilio sends as the first WS message on a new call."""
    return json.dumps(
        {
            "event": "start",
            "start": {"streamSid": stream_sid, "callSid": call_sid},
        }
    )


@pytest.mark.asyncio
async def test_two_adapters_exchange_audio_via_ws_loopback(monkeypatch):
    """Adapter A's `send_audio` → µ-law-encoded frames → B's inbound queue → B's
    `recv_audio` yields the decoded PCM. Proves the WS frame protocol is
    symmetric without a real PSTN leg."""
    # Patch REST + server so connect() is pure.
    from tests.voice.test_twilio_adapter import _install_fake_rest

    _install_fake_rest(monkeypatch)

    a = _make_adapter(port=18001)
    b = _make_adapter(port=18002)

    await a.connect()
    await b.connect()

    try:
        # Two queues form a pipe between A and B. A's outbound = B's inbound.
        a_out: asyncio.Queue[str] = asyncio.Queue()
        b_out: asyncio.Queue[str] = asyncio.Queue()

        ws_a = _BridgedWebSocket(inbound=b_out, outbound=a_out)
        ws_b = _BridgedWebSocket(inbound=a_out, outbound=b_out)

        # Each side enters its mode explicitly — the loopback bypasses the
        # REST call that place_call would make.
        a._enter_mode("call")
        b._enter_mode("answer")

        # The media_stream_loop drives state off an initial `start` frame, so
        # prime each side's inbound with one.
        await b_out.put(_start_frame("MZa", "CAa"))
        await a_out.put(_start_frame("MZb", "CAb"))

        task_a = await _drive_loop(a, ws_a, stream_sid="MZa")
        task_b = await _drive_loop(b, ws_b, stream_sid="MZb")

        # Generate a 440Hz tone. 120ms is enough to flush a full 100ms batch
        # through B's _inbound_queue without waiting on the trailing buffer.
        duration_s = 0.2
        t = np.arange(int(duration_s * 24000)) / 24000
        tone = (np.sin(2 * np.pi * 440 * t) * 16000).astype(np.int16).tobytes()

        await a.send_audio(AudioChunk(data=tone))

        # B should receive decoded PCM. First chunk = 100ms worth of 24kHz
        # PCM16 = 24000 * 0.1 * 2 ≈ 4800 bytes; allow slack for codec padding.
        chunk = await b.recv_audio(timeout=2.0)
        arr = np.frombuffer(chunk.data, dtype=np.int16)
        peak = int(np.abs(arr).max()) if len(arr) else 0
        assert peak > 5000, f"expected non-silent tone at B, got peak={peak}"

        # Symmetry: B sends a different tone, A receives it.
        tone_b = (np.sin(2 * np.pi * 880 * t) * 16000).astype(np.int16).tobytes()
        await b.send_audio(AudioChunk(data=tone_b))

        chunk_at_a = await a.recv_audio(timeout=2.0)
        arr_a = np.frombuffer(chunk_at_a.data, dtype=np.int16)
        peak_a = int(np.abs(arr_a).max()) if len(arr_a) else 0
        assert peak_a > 5000, f"expected non-silent tone at A, got peak={peak_a}"

        # Shutdown: feed each side a `stop` frame so its loop exits cleanly.
        stop_frame = json.dumps({"event": "stop"})
        await b_out.put(stop_frame)
        await a_out.put(stop_frame)
        await asyncio.wait_for(task_a, timeout=1.0)
        await asyncio.wait_for(task_b, timeout=1.0)
    finally:
        await a.disconnect()
        await b.disconnect()


@pytest.mark.asyncio
async def test_loopback_preserves_mulaw_framing(monkeypatch):
    """Direct check that outbound audio from send_audio() arrives as valid
    Media Streams `media` frames on the WS queue — no PCM leakage."""
    from tests.voice.test_twilio_adapter import _install_fake_rest

    _install_fake_rest(monkeypatch)

    a = _make_adapter(port=18003)
    await a.connect()
    try:
        a._enter_mode("call")
        outbound: asyncio.Queue[str] = asyncio.Queue()
        inbound: asyncio.Queue[str] = asyncio.Queue()
        ws = _BridgedWebSocket(inbound=inbound, outbound=outbound)
        a._stream_ws = ws
        a._stream_sid = "MZtest"

        # 40ms tone → ~320 bytes µ-law → 2 Media Streams frames (160 bytes each).
        pcm = (np.sin(2 * np.pi * 440 * np.arange(int(0.04 * 24000)) / 24000) * 16000).astype(np.int16).tobytes()
        await a.send_audio(AudioChunk(data=pcm))

        frames: list[dict[str, Any]] = []
        while not outbound.empty():
            frames.append(json.loads(outbound.get_nowait()))

        assert len(frames) >= 2, f"expected >=2 media frames, got {len(frames)}"
        for f in frames:
            assert f["event"] == "media"
            assert f["streamSid"] == "MZtest"
            assert "payload" in f["media"]
    finally:
        await a.disconnect()
