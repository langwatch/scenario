"""
Unit tests for PipecatAgentAdapter (transport="websocket") wire protocol.

Verifies the synthetic Twilio Media Streams start/media/stop handshake
without hitting a real pipecat bot. Mocks `websockets.connect`.
"""

import asyncio
import base64
import json
from typing import Any

import pytest

from scenario.voice import AudioChunk, PipecatAgentAdapter


# ---------------------------------------------------------------- fake WS

class _FakeWebSocket:
    """
    Stand-in for websockets.asyncio.client.ClientConnection. Records every
    `send()` call for verification and serves frames from `inbox` on iteration.
    """

    def __init__(self, inbox: list[str] | None = None) -> None:
        self.sent: list[str] = []
        self._inbox: asyncio.Queue[Any] = asyncio.Queue()
        self.closed = False
        for item in inbox or []:
            self._inbox.put_nowait(item)

    async def send(self, text: str) -> None:
        self.sent.append(text)

    def __aiter__(self) -> "_FakeWebSocket":
        return self

    async def __anext__(self) -> Any:
        # Block until a test feeds the queue or closes.
        item = await self._inbox.get()
        if item is _SENTINEL_CLOSE:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        self.closed = True
        await self._inbox.put(_SENTINEL_CLOSE)

    # helpers for tests
    def feed(self, frame: str) -> None:
        self._inbox.put_nowait(frame)

    def end_stream(self) -> None:
        self._inbox.put_nowait(_SENTINEL_CLOSE)


_SENTINEL_CLOSE = object()


@pytest.fixture
def patched_ws(monkeypatch):
    fake = _FakeWebSocket()

    async def _fake_connect(url, **_):
        # Accept any keepalive kwargs (ping_interval, ping_timeout, etc) the
        # production code passes; the mock ignores them.
        return fake

    monkeypatch.setattr("websockets.connect", _fake_connect)
    return fake


# ---------------------------------------------------------------- tests

@pytest.mark.asyncio
async def test_connect_sends_connected_then_start_with_fabricated_sids(patched_ws):
    a = PipecatAgentAdapter(url="ws://bot/ws")
    await a.connect()
    try:
        assert len(patched_ws.sent) == 2
        connected = json.loads(patched_ws.sent[0])
        start = json.loads(patched_ws.sent[1])

        assert connected == {"event": "connected", "protocol": "Call", "version": "1.0.0"}
        assert start["event"] == "start"
        assert start["streamSid"].startswith("MZ")
        assert start["start"]["callSid"].startswith("CA")
        assert start["start"]["mediaFormat"] == {
            "encoding": "audio/x-mulaw",
            "sampleRate": 8000,
            "channels": 1,
        }
    finally:
        patched_ws.end_stream()
        await a.disconnect()


@pytest.mark.asyncio
async def test_connect_uses_supplied_sids(patched_ws):
    a = PipecatAgentAdapter(url="ws://bot/ws", stream_sid="MZ_given", call_sid="CA_given")
    await a.connect()
    try:
        start = json.loads(patched_ws.sent[1])
        assert start["streamSid"] == "MZ_given"
        assert start["start"]["callSid"] == "CA_given"
    finally:
        patched_ws.end_stream()
        await a.disconnect()


@pytest.mark.asyncio
async def test_send_audio_emits_media_frames_20ms_each(patched_ws):
    a = PipecatAgentAdapter(url="ws://bot/ws")
    await a.connect()
    try:
        patched_ws.sent.clear()  # drop connected + start
        # 100ms of silence at 24kHz PCM16 = 4800 bytes → 100ms µ-law = 800 bytes
        # → 5 media frames of 160 bytes each, plus a trailing utterance_end mark.
        pcm = b"\x00\x00" * 2400  # 100ms
        await a.send_audio(AudioChunk(data=pcm))
        frames = [json.loads(s) for s in patched_ws.sent]
        media_frames = [f for f in frames if f["event"] == "media"]
        mark_frames = [f for f in frames if f["event"] == "mark"]
        # 5 media frames (100ms @ 20ms each) + 1 trailing utterance_end mark.
        assert len(media_frames) == 5
        assert len(frames) == len(media_frames) + len(mark_frames)
        # Each media payload decodes to ≤ 160 bytes µ-law.
        for f in media_frames:
            payload = base64.b64decode(f["media"]["payload"])
            assert len(payload) <= 160
        # Trailing mark is the explicit end-of-turn signal.
        assert mark_frames == [
            {"event": "mark", "streamSid": a.stream_sid, "mark": {"name": "utterance_end"}}
        ]
    finally:
        patched_ws.end_stream()
        await a.disconnect()


@pytest.mark.asyncio
async def test_recv_audio_decodes_incoming_media_to_pcm16(patched_ws):
    a = PipecatAgentAdapter(url="ws://bot/ws")
    await a.connect()
    try:
        # Feed 100ms of µ-law silence coming back from pipecat.
        # 8000 * 0.1 = 800 bytes.
        mulaw = b"\x7f" * 800  # silence in µ-law
        frame = json.dumps(
            {
                "event": "media",
                "streamSid": a.stream_sid,
                "media": {"payload": base64.b64encode(mulaw).decode()},
            }
        )
        patched_ws.feed(frame)

        chunk = await a.recv_audio(timeout=1.0)
        assert isinstance(chunk, AudioChunk)
        # 100ms at 24kHz PCM16 = 4800 bytes (±).
        assert 4500 < len(chunk.data) < 5000
    finally:
        patched_ws.end_stream()
        await a.disconnect()


@pytest.mark.asyncio
async def test_disconnect_sends_stop_then_closes(patched_ws):
    a = PipecatAgentAdapter(url="ws://bot/ws")
    await a.connect()
    stream_sid = a.stream_sid
    patched_ws.sent.clear()

    patched_ws.end_stream()  # so the recv loop can exit cleanly
    await a.disconnect()

    # Last sent message should be a `stop` event for the stream.
    sent_stops = [json.loads(s) for s in patched_ws.sent if "stop" in s]
    assert sent_stops, f"expected stop frame, got {patched_ws.sent}"
    assert sent_stops[0] == {"event": "stop", "streamSid": stream_sid}
    assert patched_ws.closed


@pytest.mark.asyncio
async def test_webrtc_transport_raises_pending():
    from scenario.voice.adapters import PendingTransportError

    a = PipecatAgentAdapter(transport="webrtc", signaling_url="https://x/api/offer")
    with pytest.raises(PendingTransportError):
        await a.connect()


def test_websocket_transport_requires_url():
    with pytest.raises(ValueError, match="requires url"):
        PipecatAgentAdapter(transport="websocket")


def test_webrtc_transport_requires_signaling_url():
    with pytest.raises(ValueError, match="requires signaling_url"):
        PipecatAgentAdapter(transport="webrtc")
