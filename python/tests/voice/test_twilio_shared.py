"""
Unit tests for scenario.voice.adapters._twilio_shared — the µ-law codec,
Media Streams frame parser, and E.164 validator.

The full adapter e2e test lives in examples/voice/twilio_{inbound,outbound}.py
(manual, real-phone).
"""

import base64
import json

import numpy as np
import pytest

from scenario.voice.adapters._twilio_shared import (
    TWILIO_FRAME_BYTES,
    _redact_e164,
    build_clear_frame,
    build_media_frame,
    iter_mulaw_frames,
    mulaw8k_to_pcm16_24k,
    parse_media_stream_frame,
    pcm16_24k_to_mulaw8k,
    validate_e164,
)


# ---------------------------------------------------------------- E.164

def test_validate_e164_accepts_typical_numbers():
    validate_e164("+14155551234")
    validate_e164("+3197010223520")  # Netherlands
    validate_e164("+442071838750")   # UK


@pytest.mark.parametrize(
    "bad",
    [
        "4155551234",    # missing +
        "+04155551234",  # leading 0 after +
        "+",             # empty
        "+12",           # too short (<7 digits after +)
        "+1" + "2" * 15, # too long (>15 digits after +)
        "+1-415-555-1234",  # hyphens
        "",
    ],
)
def test_validate_e164_rejects_malformed(bad):
    with pytest.raises(ValueError, match="E.164"):
        validate_e164(bad)


# ---------------------------------------------------------------- codec

def test_roundtrip_preserves_length_proportion():
    # 1 second of silence at 24kHz PCM16 mono.
    pcm = b"\x00\x00" * 24000
    mulaw = pcm16_24k_to_mulaw8k(pcm)
    # 1s at 8kHz µ-law = 8000 bytes
    assert abs(len(mulaw) - 8000) < 100, f"got {len(mulaw)} bytes of µ-law"
    # Round-trip back to 24kHz PCM16
    pcm_back = mulaw8k_to_pcm16_24k(mulaw)
    # 1s at 24kHz PCM16 = 48000 bytes
    assert abs(len(pcm_back) - 48000) < 200, f"got {len(pcm_back)} bytes of PCM16"


def test_roundtrip_preserves_signal_shape():
    # Sine wave at 440Hz
    t = np.arange(24000) / 24000  # 1s at 24kHz
    signal = (np.sin(2 * np.pi * 440 * t) * 20000).astype(np.int16)
    pcm = signal.tobytes()
    mulaw = pcm16_24k_to_mulaw8k(pcm)
    pcm_back = mulaw8k_to_pcm16_24k(mulaw)
    signal_back = np.frombuffer(pcm_back, dtype=np.int16)
    # After µ-law round-trip we've lossy-compressed; correlation should be strong.
    # Align lengths (rate conversion can add/drop a few samples at boundaries).
    n = min(len(signal), len(signal_back))
    # Normalize to avoid scale sensitivity.
    a = signal[:n].astype(float)
    b = signal_back[:n].astype(float)
    a /= np.max(np.abs(a)) or 1
    b /= np.max(np.abs(b)) or 1
    corr = np.corrcoef(a, b)[0, 1]
    assert corr > 0.8, f"µ-law round-trip lost too much signal (corr={corr:.3f})"


def test_empty_input_returns_empty():
    assert mulaw8k_to_pcm16_24k(b"") == b""
    assert pcm16_24k_to_mulaw8k(b"") == b""


def test_iter_mulaw_frames_splits_into_20ms_chunks():
    # 80ms of µ-law = 4 × 160 bytes
    buf = b"\xff" * (TWILIO_FRAME_BYTES * 4)
    frames = list(iter_mulaw_frames(buf))
    assert len(frames) == 4
    assert all(len(f) == TWILIO_FRAME_BYTES for f in frames)


def test_iter_mulaw_frames_final_short_frame():
    # 170 bytes → one full 160-byte frame + one 10-byte tail.
    frames = list(iter_mulaw_frames(b"\x00" * 170))
    assert len(frames) == 2
    assert len(frames[0]) == TWILIO_FRAME_BYTES
    assert len(frames[1]) == 10


# ---------------------------------------------------------------- frame parsing

def test_parse_start_frame_captures_stream_and_call_sid():
    frame = json.dumps(
        {
            "event": "start",
            "streamSid": "MZ_stream",
            "start": {"streamSid": "MZ_stream", "callSid": "CA_call"},
        }
    )
    parsed = parse_media_stream_frame(frame)
    assert parsed is not None
    assert parsed.event == "start"
    assert parsed.stream_sid == "MZ_stream"
    assert parsed.call_sid == "CA_call"


def test_parse_media_frame_decodes_base64_payload():
    raw_mulaw = bytes(range(50))
    frame = json.dumps(
        {
            "event": "media",
            "streamSid": "MZ_x",
            "media": {"payload": base64.b64encode(raw_mulaw).decode("ascii")},
        }
    )
    parsed = parse_media_stream_frame(frame)
    assert parsed is not None
    assert parsed.event == "media"
    assert parsed.payload_mulaw == raw_mulaw


def test_parse_dtmf_frame_extracts_digit():
    frame = json.dumps({"event": "dtmf", "streamSid": "MZ_x", "dtmf": {"digit": "5"}})
    parsed = parse_media_stream_frame(frame)
    assert parsed is not None
    assert parsed.event == "dtmf"
    assert parsed.dtmf_digit == "5"


def test_parse_stop_frame_recognised():
    frame = json.dumps({"event": "stop", "streamSid": "MZ_x"})
    parsed = parse_media_stream_frame(frame)
    assert parsed is not None
    assert parsed.event == "stop"


def test_parse_non_json_returns_none():
    assert parse_media_stream_frame("not json") is None


def test_parse_unknown_event_returns_none():
    assert parse_media_stream_frame(json.dumps({"event": "mystery"})) is None


# ---------------------------------------------------------------- frame building

def test_build_media_frame_base64_encodes_payload():
    raw = bytes([10, 20, 30, 40])
    text = build_media_frame("MZ_x", raw)
    obj = json.loads(text)
    assert obj["event"] == "media"
    assert obj["streamSid"] == "MZ_x"
    assert base64.b64decode(obj["media"]["payload"]) == raw


def test_build_clear_frame():
    text = build_clear_frame("MZ_x")
    obj = json.loads(text)
    assert obj == {"event": "clear", "streamSid": "MZ_x"}



# ---------------------------------------------------------------- redact_e164
# These pin the safety invariant: short or malformed inputs must NEVER leak
# more than the last-4 digits, and never the leading "+" or country code.

@pytest.mark.parametrize(
    "short_input",
    ["", "+", "+1", "+12", "+123"],  # all <4 chars → fully redacted
)
def test_redact_e164_short_input_never_leaks_digits(short_input):
    assert _redact_e164(short_input) == "***"


def test_redact_e164_full_e164_leaks_only_last_4():
    assert _redact_e164("+14155551234") == "***1234"
    assert _redact_e164("+3197010223520") == "***3520"


def test_redact_e164_non_digit_input_is_fully_redacted():
    # Non-digit junk has 0 extractable digits → "***", never the input.
    assert _redact_e164("abcd") == "***"
    assert _redact_e164("not a number") == "***"


def test_redact_e164_strips_punctuation_before_taking_last_4():
    # Common log scrapings include hyphens or spaces — last-4 must be of
    # digits, not characters, to avoid leaking separator artefacts.
    assert _redact_e164("+1-415-555-1234") == "***1234"
    assert _redact_e164("+1 (415) 555 1234") == "***1234"
