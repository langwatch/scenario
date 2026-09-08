"""
Ungated a-leg bidirectional frame-loop tripwire (scenario#762 Slice 5, AC14).

AC11's live smoke is the only REAL proof that a-leg carries audio, and its env
gate never trips in CI — so on its own an a-leg frame-loop regression ships
green. This test is the standing substitute: it drives the production media loop
over the scripted in-memory socket the nonce tests already use, and asserts on
the BYTES that come out of the real codec in both directions.

Nothing here is mocked below the socket: the µ-law decode, the 8k→24k resample,
the 20ms framing and the base64 wire encoding are all the shipped ones. The
expected sample values are computed by an independent G.711 µ-law decoder
implemented in this file, so a broken codec cannot agree with the assertion by
construction.

Binds AC14 of ``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-frame-loop.test.ts``.
"""

import asyncio
import base64
import json
import struct

import pytest

from scenario.voice import AudioChunk
from scenario.voice.adapters._twilio_server import TwilioWebhookServer
from scenario.voice.adapters._twilio_shared import TWILIO_FRAME_BYTES

from .test_twilio_adapter import _install_fake_rest, _make_adapter
from .test_twilio_stream_auth import _ScriptedWS, _place_a_leg_call, _start_frame

#: One 100ms batch — what the loop coalesces before it enqueues a chunk.
FRAMES_PER_BATCH = 5
#: Arbitrary non-silent µ-law code. Constant across the batch so the resampler's
#: interpolation is the identity on it and every decoded sample is comparable.
TONE_MULAW_BYTE = 0xD5
#: Constant PCM16-at-24kHz level for the outbound direction, well inside int16.
TONE_PCM16_LEVEL = 1000


def _mulaw_decode(byte: int) -> int:
    """Independent G.711 µ-law decode of one byte to a signed 16-bit sample.

    Deliberately NOT the adapter's decoder: this is the reference the shipped
    codec is checked against, so it has to be able to disagree with it.
    """
    inverted = ~byte & 0xFF
    magnitude = ((((inverted & 0x0F) << 3) | 0x84) << ((inverted >> 4) & 0x07)) - 0x84
    return -magnitude if inverted & 0x80 else magnitude


def _media_frame(payload: bytes, stream_sid: str = "MZ762") -> str:
    """An inbound Twilio ``media`` frame, built here rather than by the adapter.

    The adapter's own frame builder is the thing under test on the OUTBOUND
    side; using it to author inbound fixtures too would let one bug cancel out
    the other.
    """
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(payload).decode("ascii")},
        }
    )


def _samples(pcm16: bytes) -> tuple[int, ...]:
    return struct.unpack(f"<{len(pcm16) // 2}h", pcm16)


@pytest.mark.asyncio
async def test_a_leg_loop_carries_audio_in_both_directions(monkeypatch):
    """AC14: inbound µ-law arrives decoded on the adapter's queue, and outbound
    audio leaves the socket as correctly-framed µ-law ``media`` frames."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    rest = rest_instances[0]
    try:
        nonce = await _place_a_leg_call(a, rest)

        inbound_mulaw = bytes([TONE_MULAW_BYTE]) * TWILIO_FRAME_BYTES
        ws = _ScriptedWS(
            [_start_frame(nonce=nonce)]
            + [_media_frame(inbound_mulaw) for _ in range(FRAMES_PER_BATCH)]
        )
        # Run the loop for the whole test rather than driving it to completion:
        # send_audio needs the socket still adopted and the stream still live,
        # which only holds while the loop is parked on its next read.
        loop_task = asyncio.create_task(TwilioWebhookServer(a).media_stream_loop(ws))
        try:
            # ---------------------------------------------------- inbound
            chunk = await asyncio.wait_for(a.recv_audio(timeout=1.0), timeout=2.0)
            decoded = _samples(chunk.data)
            expected_level = _mulaw_decode(TONE_MULAW_BYTE)

            assert set(decoded) == {expected_level}, (
                "inbound µ-law must reach the queue decoded to PCM16 by the real "
                f"codec (expected every sample == {expected_level})"
            )
            # 8k → 24k on 5×160 µ-law samples: 3× the samples, ± the resampler's
            # end-of-buffer rounding.
            assert abs(len(decoded) - 3 * FRAMES_PER_BATCH * TWILIO_FRAME_BYTES) <= 2
            assert a._frames_received == FRAMES_PER_BATCH

            # ---------------------------------------------------- outbound
            outbound_samples = 2400  # 100ms at 24kHz
            await a.send_audio(
                AudioChunk(
                    data=struct.pack(
                        f"<{outbound_samples}h", *([TONE_PCM16_LEVEL] * outbound_samples)
                    )
                )
            )

            frames = [json.loads(text) for text in ws.sent]
            assert [f["event"] for f in frames] == ["media"] * FRAMES_PER_BATCH
            assert {f["streamSid"] for f in frames} == {"MZ762"}

            payloads = [base64.b64decode(f["media"]["payload"]) for f in frames]
            assert [len(p) for p in payloads] == [TWILIO_FRAME_BYTES] * FRAMES_PER_BATCH
            emitted = b"".join(payloads)
            levels = {_mulaw_decode(byte) for byte in emitted}
            assert len(levels) == 1, "a constant input must encode to a constant code"
            # µ-law is logarithmic: at this level its quantum is ~30, so the
            # round-trip lands near the input rather than on it.
            assert abs(levels.pop() - TONE_PCM16_LEVEL) <= 32
        finally:
            loop_task.cancel()
            await asyncio.gather(loop_task, return_exceptions=True)
    finally:
        await a.disconnect()
