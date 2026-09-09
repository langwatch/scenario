"""
Ungated a-leg bidirectional frame-loop tripwire (scenario#762 Slice 5, AC14).

AC11's live smoke is the only REAL proof that a-leg carries audio, and its env
gate never trips in CI — so on its own an a-leg frame-loop regression ships
green. This test is the standing substitute: it drives the production media loop
over the scripted in-memory socket the nonce tests already use, and asserts on
the BYTES that come out of the real codec in both directions.

Nothing here is mocked below the socket: the µ-law decode, the 8k→24k resample,
the 20ms framing and the base64 wire encoding are all the shipped ones. The
expected sample values come from an independent G.711 µ-law decoder implemented
in this file, and are compared POSITIONALLY against a waveform that visits all
256 µ-law code points. That combination is what makes the reference decoder able
to disagree: a set-membership assertion over a constant tone is invariant under
any permutation, duplication or drop of the samples — reversing the shipped
decoder's output passed it — and it exercises 1 of 256 codes, leaving the
negative half of the table, the segment shift and the bias term unchecked.

Binds AC14 of ``specs/voice-twilio-a-leg-external.feature``. Mirrors
``javascript/src/voice/adapters/__tests__/twilio-frame-loop.test.ts``.
"""

import base64
import json
import struct

import pytest

from scenario.voice import AudioChunk
from scenario.voice.adapters._twilio_shared import TWILIO_FRAME_BYTES

from .a_leg_harness import _driving, _place_a_leg_call, _ScriptedWS, _start_frame
from .test_twilio_adapter import _install_fake_rest, _make_adapter

#: One 100ms batch — what the loop coalesces before it enqueues a chunk.
FRAMES_PER_BATCH = 5
#: µ-law bytes in one 100ms batch.
BATCH_MULAW_BYTES = FRAMES_PER_BATCH * TWILIO_FRAME_BYTES  # 800
#: Both rates are fixed by the transports, so the 8k→24k factor is a constant.
UPSAMPLE_FACTOR = 3


def _mulaw_decode(byte: int) -> int:
    """Independent G.711 µ-law decode of one byte to a signed 16-bit sample.

    Deliberately NOT the adapter's decoder: this is the reference the shipped
    codec is checked against, so it has to be able to disagree with it.
    """
    inverted = ~byte & 0xFF
    magnitude = ((((inverted & 0x0F) << 3) | 0x84) << ((inverted >> 4) & 0x07)) - 0x84
    return -magnitude if inverted & 0x80 else magnitude


#: One batch of µ-law that visits every code point, so no assertion below can
#: be satisfied by a codec that only handles the positive half of the table, or
#: by one that reorders, drops or duplicates samples.
RAMP_MULAW = bytes((i % 256) for i in range(BATCH_MULAW_BYTES))
#: What the reference decoder says each of those bytes is worth.
RAMP_PCM16_8K = [_mulaw_decode(byte) for byte in RAMP_MULAW]


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
        nonce, call = await _place_a_leg_call(a, rest)

        frames = [
            RAMP_MULAW[i : i + TWILIO_FRAME_BYTES]
            for i in range(0, BATCH_MULAW_BYTES, TWILIO_FRAME_BYTES)
        ]
        ws = _ScriptedWS(
            [_start_frame(nonce=nonce)] + [_media_frame(f) for f in frames]
        )
        # Hold the loop open for the whole test: send_audio needs the socket
        # still adopted and the stream still live, which only holds while the
        # loop is parked on its next read.
        async with _driving(a, ws):
            # ---------------------------------------------------- inbound
            chunk = await a.recv_audio(timeout=1.0)
            decoded = _samples(chunk.data)

            # 8k → 24k with linear interpolation puts input sample i exactly on
            # output index 3i, so the reference decoder can be checked sample by
            # sample — the whole point of driving a VARYING waveform.
            assert [decoded[UPSAMPLE_FACTOR * i] for i in range(BATCH_MULAW_BYTES - 1)] == (
                RAMP_PCM16_8K[:-1]
            ), "inbound µ-law reached the queue mis-decoded, reordered or resampled wrong"
            # ± the resampler's end-of-buffer rounding.
            assert abs(len(decoded) - UPSAMPLE_FACTOR * BATCH_MULAW_BYTES) <= 2
            assert a._frames_received == FRAMES_PER_BATCH

            # ---------------------------------------------------- outbound
            # Hold each 8kHz level for 3 samples at 24kHz so the downsample is
            # the exact inverse of the upsample above; every value is already a
            # µ-law quantisation level, so the encode round-trips exactly and a
            # positional assertion needs no tolerance.
            outbound = [level for level in RAMP_PCM16_8K for _ in range(UPSAMPLE_FACTOR)]
            await a.send_audio(
                AudioChunk(data=struct.pack(f"<{len(outbound)}h", *outbound))
            )

            sent = [json.loads(text) for text in ws.sent]
            assert [f["event"] for f in sent] == ["media"] * FRAMES_PER_BATCH
            assert {f["streamSid"] for f in sent} == {"MZ762"}

            payloads = [base64.b64decode(f["media"]["payload"]) for f in sent]
            assert [len(p) for p in payloads] == [TWILIO_FRAME_BYTES] * FRAMES_PER_BATCH
            emitted = b"".join(payloads)
            assert [_mulaw_decode(byte) for byte in emitted] == RAMP_PCM16_8K, (
                "outbound PCM16 left the socket mis-encoded, reordered or resampled wrong"
            )
        await call
    finally:
        await a.disconnect()
