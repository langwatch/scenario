"""Twilio quiet media must leave an arrival gap for the response drain."""

from __future__ import annotations

import asyncio
import base64
import json
import struct
from typing import Literal

import pytest
import websockets
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from scenario.voice import AudioChunk, TwilioSpeechGateOptions, extract_audio
from scenario.voice.adapters._twilio_speech_gate import TwilioSpeechGate
from scenario.voice.testing.wrapper_harness import (
    drive_call,
    drive_twilio_production,
    free_port,
    make_connected_twilio_adapter,
    serve_real_twilio_route,
)

from .test_twilio_adapter import _install_fake_rest, _make_adapter
from .test_twilio_silent_stop_drain import _ScriptedWS, _start_frame, _stop_frame


def _media_batches(level: int, count: int) -> list[str]:
    """Build 100 ms batches from five standard 20 ms media frames."""
    frame = json.dumps(
        {
            "event": "media",
            "media": {"payload": base64.b64encode(bytes([level]) * 160).decode()},
        }
    )
    return [frame] * (5 * count)


@pytest.mark.asyncio
async def test_media_loop_gates_quiet_batches_and_preserves_terminal() -> None:
    adapter = make_connected_twilio_adapter()
    ws = _ScriptedWS(
        [_start_frame()]
        + _media_batches(0xFF, 4)
        + _media_batches(0x90, 1)
        + _media_batches(0xFF, 10)
        + [_stop_frame()]
    )

    await drive_twilio_production(adapter, ws)

    assert adapter._inbound_queue is not None
    chunks = []
    while not adapter._inbound_queue.empty():
        chunks.append(adapter._inbound_queue.get_nowait())
    assert len([chunk for chunk in chunks if chunk.data]) == 8
    assert chunks[-1].data == b""


def _tone(amplitude: int, ms: int = 100) -> AudioChunk:
    """PCM16 audio with known RMS and duration, including negative samples."""
    return AudioChunk(data=struct.pack("<h", amplitude) * (24 * ms))


@pytest.mark.parametrize("amplitude", [0, 799, 800, -800, 32767, -32768])
def test_pcm16_speech_threshold(amplitude: int) -> None:
    gate = TwilioSpeechGate(TwilioSpeechGateOptions(preroll_ms=0))
    chunk = _tone(amplitude)
    assert gate.admit(chunk) == ([chunk] if abs(amplitude) >= 800 else [])


def test_bounded_preroll_and_hangover_keep_short_pauses() -> None:
    gate = TwilioSpeechGate(TwilioSpeechGateOptions(preroll_ms=200))
    quiet = [_tone(i) for i in range(10)]
    for chunk in quiet:
        assert gate.admit(chunk) == []
    speech = _tone(1380)
    assert gate.admit(speech) == [*quiet[-2:], speech]
    assert gate.dropped_chunks == 8
    assert gate.dropped_ms == 800
    assert gate.admit(quiet[0]) == [quiet[0]]
    assert gate.admit(speech) == [speech]
    assert gate.onsets == 1
    for _ in range(4):
        assert gate.admit(quiet[0]) == [quiet[0]]
    assert gate.admit(quiet[0]) == []
    assert gate.admit(speech) == [quiet[0], speech]
    assert gate.onsets == 2


@pytest.mark.parametrize("reset", ["reset", "reset_counters", "terminal"])
def test_call_reset_drops_preroll(reset: str) -> None:
    gate = TwilioSpeechGate()
    gate.admit(_tone(740))
    if reset == "terminal":
        terminal = AudioChunk(data=b"")
        assert gate.admit(terminal) == [terminal]
    else:
        getattr(gate, reset)()
    assert gate.dropped_chunks == (0 if reset == "reset_counters" else 1)
    speech = _tone(1380)
    assert gate.admit(speech) == [speech]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "speech_gate", [False, TwilioSpeechGateOptions(rms_threshold=0)]
)
async def test_gate_controls_allow_quiet_audio(
    monkeypatch: pytest.MonkeyPatch,
    speech_gate: TwilioSpeechGateOptions | Literal[False],
) -> None:
    _install_fake_rest(monkeypatch)
    adapter = _make_adapter(speech_gate=speech_gate)
    await adapter.connect()
    try:
        await drive_twilio_production(
            adapter,
            _ScriptedWS([_start_frame()] + _media_batches(0xFF, 5) + [_stop_frame()]),
        )
        assert adapter._inbound_queue is not None
        assert adapter._inbound_queue.qsize() == 6
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_real_route_ends_turn_while_quiet_media_continues() -> None:
    adapter = make_connected_twilio_adapter(http_port=free_port())
    adapter.response_tail_silence = 0.25
    async with serve_real_twilio_route(adapter) as url:
        async with websockets.connect(url) as ws:
            await ws.send(_start_frame())
            assert adapter._stream_connected is not None
            await asyncio.wait_for(adapter._stream_connected.wait(), timeout=2)

            async def stream_media() -> None:
                for frame in _media_batches(0x90, 1):
                    await ws.send(frame)
                    await asyncio.sleep(0.02)
                while True:
                    for frame in _media_batches(0xFF, 1):
                        await ws.send(frame)
                        await asyncio.sleep(0.02)

            producer = asyncio.create_task(stream_media())
            try:
                result = await asyncio.wait_for(drive_call(adapter), timeout=2)
                audio = extract_audio(result)
                assert audio is not None
                assert audio.duration_seconds == pytest.approx(0.5, abs=0.005)
                assert not adapter._stream_ended
                assert not producer.done()
            finally:
                producer.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await producer


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [True, False])
async def test_disconnect_reports_gate_counters_then_resets(
    monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> None:
    _install_fake_rest(monkeypatch)
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(trace, "_TRACER_PROVIDER", provider)
    adapter = _make_adapter(speech_gate=None if enabled else False)
    await adapter.connect()
    try:
        await drive_twilio_production(
            adapter,
            _ScriptedWS(
                [_start_frame()]
                + _media_batches(0xFF, 4)
                + _media_batches(0x90, 1)
                + _media_batches(0xFF, 10)
                + [_stop_frame()]
            ),
        )
    finally:
        with provider.get_tracer(__name__).start_as_current_span(
            "voice.adapter.disconnect"
        ):
            await adapter.disconnect()
        provider.shutdown()
    attributes = exporter.get_finished_spans()[-1].attributes
    assert attributes is not None
    prefix = "voice.twilio.speech_gate."
    assert attributes[prefix + "enabled"] is enabled
    assert attributes[prefix + "dropped_chunks"] == (7 if enabled else 0)
    assert attributes[prefix + "dropped_ms"] == pytest.approx(
        700 if enabled else 0, abs=2
    )
    assert attributes[prefix + "onsets"] == (1 if enabled else 0)
    if adapter._speech_gate is not None:
        assert adapter._speech_gate.dropped_chunks == 0
        assert adapter._speech_gate.onsets == 0
