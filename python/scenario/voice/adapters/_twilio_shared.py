"""
Shared primitives for TwilioAgentAdapter transports.

- µ-law 8kHz ↔ PCM16 24kHz codec (Twilio Media Streams uses µ-law 8kHz; our
  canonical internal format is PCM16 24kHz mono).
- Media Streams WebSocket frame parser/serializer (the JSON schema Twilio
  sends on its bidirectional WS at ``wss://.../twilio/stream``).
- REST client helpers: webhook read/write/restore, outbound call placement.

Not exported from ``scenario.voice`` — internal to the Twilio adapter.
"""

from __future__ import annotations

import audioop
import base64
import json
import logging
import re
from dataclasses import dataclass
from typing import Iterator, Optional


logger = logging.getLogger("scenario.voice.twilio")


# Twilio Media Streams always uses µ-law 8kHz mono.
TWILIO_SAMPLE_RATE = 8000
# Our canonical internal format. Single source of truth lives in audio_chunk;
# re-exported here so existing imports don't break.
from ..audio_chunk import PCM16_SAMPLE_RATE  # noqa: E402
PCM16_SAMPLE_WIDTH = 2
# Twilio Media Streams delivers audio in 20ms frames (160 µ-law bytes each).
TWILIO_FRAME_MS = 20
TWILIO_FRAME_BYTES = TWILIO_SAMPLE_RATE * TWILIO_FRAME_MS // 1000  # 160


E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")

# DTMF tones: digits 0–9, star, pound, wait-1sec (w, W). No other chars.
# Guards against TwiML XML injection in send_dtmf_on_call.
DTMF_RE = re.compile(r"^[0-9*#wW]+$")


def validate_e164(phone_number: str) -> None:
    """Raise ValueError if phone_number is not a valid E.164 number."""
    if not E164_RE.match(phone_number):
        raise ValueError(
            f"phone_number {phone_number!r} is not in E.164 format "
            f"(expected e.g. '+14155551234', pattern: leading '+' then 7–15 digits)."
        )


def validate_dtmf(tones: str) -> None:
    """Raise ValueError if tones contains anything other than valid DTMF chars.

    Required before embedding `tones` into TwiML — unvalidated input would
    allow XML injection (e.g., a value of `1"/><Say>x</Say><Play digits="`
    produces valid TwiML Twilio will execute).
    """
    if not tones or not DTMF_RE.match(tones):
        raise ValueError(
            f"DTMF tones {tones!r} must match [0-9*#wW]+ — "
            "this string is embedded in TwiML, non-DTMF chars are rejected "
            "to prevent XML injection."
        )


# ---------------------------------------------------------------- codec


def mulaw8k_to_pcm16_24k(mulaw_bytes: bytes) -> bytes:
    """Decode µ-law 8kHz mono → PCM16 24kHz mono."""
    if not mulaw_bytes:
        return b""
    pcm_8k = audioop.ulaw2lin(mulaw_bytes, PCM16_SAMPLE_WIDTH)
    pcm_24k, _ = audioop.ratecv(
        pcm_8k,
        PCM16_SAMPLE_WIDTH,
        1,  # mono
        TWILIO_SAMPLE_RATE,
        PCM16_SAMPLE_RATE,
        None,
    )
    return pcm_24k


def pcm16_24k_to_mulaw8k(pcm16_bytes: bytes) -> bytes:
    """Encode PCM16 24kHz mono → µ-law 8kHz mono."""
    if not pcm16_bytes:
        return b""
    pcm_8k, _ = audioop.ratecv(
        pcm16_bytes,
        PCM16_SAMPLE_WIDTH,
        1,  # mono
        PCM16_SAMPLE_RATE,
        TWILIO_SAMPLE_RATE,
        None,
    )
    return audioop.lin2ulaw(pcm_8k, PCM16_SAMPLE_WIDTH)


def iter_mulaw_frames(mulaw_bytes: bytes) -> Iterator[bytes]:
    """Split a µ-law buffer into 20ms (160-byte) frames for Media Streams."""
    for i in range(0, len(mulaw_bytes), TWILIO_FRAME_BYTES):
        yield mulaw_bytes[i : i + TWILIO_FRAME_BYTES]


# ---------------------------------------------------------------- frame protocol


@dataclass
class MediaStreamEvent:
    """Parsed Twilio Media Streams event."""

    event: str  # "connected" | "start" | "media" | "stop" | "dtmf" | "mark"
    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    payload_mulaw: Optional[bytes] = None  # decoded from media/base64
    dtmf_digit: Optional[str] = None
    mark_name: Optional[str] = None


def parse_media_stream_frame(text: str) -> Optional[MediaStreamEvent]:
    """
    Parse a JSON frame received from Twilio Media Streams.

    Returns None for events we don't care about (e.g. unknown types).
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.debug("twilio_ws: received non-JSON frame, ignoring")
        return None

    event = data.get("event")
    if not isinstance(event, str):
        return None

    start = data.get("start") or {}
    stream_sid = data.get("streamSid") or start.get("streamSid")
    call_sid = start.get("callSid")

    if event == "media":
        media = data.get("media") or {}
        b64 = media.get("payload")
        if not isinstance(b64, str):
            return None
        try:
            payload = base64.b64decode(b64)
        except (ValueError, TypeError):
            logger.debug("twilio_ws: bad base64 in media frame, ignoring")
            return None
        return MediaStreamEvent(
            event="media",
            stream_sid=stream_sid,
            call_sid=call_sid,
            payload_mulaw=payload,
        )

    if event == "dtmf":
        dtmf = data.get("dtmf") or {}
        digit = dtmf.get("digit")
        if not isinstance(digit, str):
            return None
        return MediaStreamEvent(
            event="dtmf",
            stream_sid=stream_sid,
            dtmf_digit=digit,
        )

    if event == "mark":
        mark = data.get("mark") or {}
        return MediaStreamEvent(
            event="mark",
            stream_sid=stream_sid,
            mark_name=mark.get("name"),
        )

    if event in {"connected", "start", "stop"}:
        return MediaStreamEvent(event=event, stream_sid=stream_sid, call_sid=call_sid)

    return None


def build_media_frame(stream_sid: str, mulaw_payload: bytes) -> str:
    """Build an outbound ``media`` JSON frame for Twilio Media Streams."""
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(mulaw_payload).decode("ascii")},
        }
    )


def build_clear_frame(stream_sid: str) -> str:
    """Build an outbound ``clear`` frame — tells Twilio to drop buffered audio.

    Used for interruption handling: if the agent was speaking and the user
    interrupts, we send ``clear`` so in-flight TTS isn't played.
    """
    return json.dumps({"event": "clear", "streamSid": stream_sid})


def build_mark_frame(stream_sid: str, name: str) -> str:
    """Build an outbound ``mark`` frame — a named marker in the audio stream.

    Twilio Media Streams natively supports marks: the sender embeds a marker
    after a chunk of audio, the receiver echoes it back once that audio has
    been played out. Our stub bot uses ``utterance_end`` marks as an
    explicit end-of-turn signal so it doesn't have to guess via VAD timing.
    """
    return json.dumps(
        {
            "event": "mark",
            "streamSid": stream_sid,
            "mark": {"name": name},
        }
    )


# ---------------------------------------------------------------- REST helpers


class TwilioRESTHelper:
    """
    Thin wrapper around ``twilio.rest.Client`` that exposes just the
    operations the adapter needs: resolve number SID, read/write voice_url,
    place outbound calls, send DTMF on an active call.

    Isolated so the adapter's async code can stay mock-friendly in unit
    tests without mocking the whole Twilio SDK.
    """

    def __init__(self, account_sid: str, auth_token: str) -> None:
        # Lazy import keeps test startup fast and makes mocking simpler.
        from twilio.rest import Client

        self._client = Client(account_sid, auth_token)

    def resolve_phone_number_sid(self, phone_number: str) -> str:
        """Look up the ``PN…`` SID for a Twilio-owned phone number."""
        numbers = self._client.incoming_phone_numbers.list(phone_number=phone_number, limit=1)
        if not numbers:
            raise RuntimeError(
                f"No incoming phone number found on this Twilio account matching "
                f"{phone_number!r}. Check that the number is purchased and in E.164."
            )
        # Twilio always returns non-None sid for list results; pyright type stubs
        # are too loose.
        return str(numbers[0].sid)

    def read_voice_url(self, phone_number_sid: str) -> Optional[str]:
        """Fetch the current ``voice_url`` configured on the number."""
        record = self._client.incoming_phone_numbers(phone_number_sid).fetch()
        return getattr(record, "voice_url", None) or None

    def write_voice_url(self, phone_number_sid: str, voice_url: str) -> None:
        self._client.incoming_phone_numbers(phone_number_sid).update(voice_url=voice_url)

    def place_call(self, *, to: str, from_: str, twiml_url: str) -> str:
        """Originate an outbound call. Returns the call SID."""
        call = self._client.calls.create(to=to, from_=from_, url=twiml_url)
        # Twilio always returns non-None sid for create results; see above.
        return str(call.sid)

    def send_dtmf_on_call(self, call_sid: str, tones: str) -> None:
        """Send DTMF on an in-progress call via the REST ``send_digits`` update.

        `tones` is validated against the DTMF charset before TwiML composition
        to prevent XML injection.
        """
        validate_dtmf(tones)
        # Twilio's pattern for sending DTMF mid-call is to update the call with
        # a new TwiML that contains <Play digits="..."/>. This requires a
        # TwiML URL or an inline TwiML string.
        twiml = f'<Response><Play digits="{tones}"/></Response>'
        self._client.calls(call_sid).update(twiml=twiml)


__all__ = [
    "TWILIO_SAMPLE_RATE",
    "PCM16_SAMPLE_RATE",
    "TWILIO_FRAME_BYTES",
    "E164_RE",
    "DTMF_RE",
    "validate_e164",
    "validate_dtmf",
    "mulaw8k_to_pcm16_24k",
    "pcm16_24k_to_mulaw8k",
    "iter_mulaw_frames",
    "MediaStreamEvent",
    "parse_media_stream_frame",
    "build_media_frame",
    "build_clear_frame",
    "build_mark_frame",
    "TwilioRESTHelper",
]
