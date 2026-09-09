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
import secrets
from dataclasses import dataclass, field
from typing import Iterator, Optional, Protocol, runtime_checkable


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

#: Byte length of the per-call media-stream nonce (a-leg WS auth, #762).
#: 16 bytes = 128 bits — UUIDv4-grade entropy, far beyond guessing for a value
#: that lives only for one call. Rendered as lowercase hex because hex survives
#: Twilio's <Parameter> round-trip with no alphabet, padding, or case ambiguity.
STREAM_NONCE_BYTES = 16
#: Length of the hex rendering of a minted nonce.
STREAM_NONCE_HEX_LEN = STREAM_NONCE_BYTES * 2


#: Hard ceiling on how long an a-leg call may live, in seconds (#762 guardrail
#: (b)). A-leg mode dials numbers we do not own, so a runaway call is a runaway
#: bill; 300s is well past any scenario turn-taking demo and far short of a
#: forgotten-call disaster. A per-call value ABOVE this cap is a caller error,
#: never a silent clamp — see ``resolve_max_call_duration``.
MAX_CALL_DURATION_CAP_SECONDS = 300
#: Applied when an a-leg ``place_call`` names no duration. Equal to the cap: an
#: unspecified duration must still be bounded, and the safest bound we are
#: willing to grant at all is the one the cap already sets.
DEFAULT_MAX_CALL_DURATION_SECONDS = MAX_CALL_DURATION_CAP_SECONDS


def resolve_max_call_duration(requested: Optional[int]) -> int:
    """Resolve an a-leg call's maximum duration in seconds.

    ``None`` yields :data:`DEFAULT_MAX_CALL_DURATION_SECONDS`. A request above
    :data:`MAX_CALL_DURATION_CAP_SECONDS` raises rather than clamping: the cap
    exists to bound spend, and a caller who silently receives a shorter call
    than the one they asked for debugs the wrong problem.

    Distinct from ``place_call``'s ``timeout``, which bounds how long we WAIT
    FOR THE MEDIA STREAM TO CONNECT, not how long the call may last.
    """
    if requested is None:
        return DEFAULT_MAX_CALL_DURATION_SECONDS
    if requested <= 0:
        raise ValueError(
            f"max_call_duration_seconds must be a positive number of seconds, "
            f"got {requested!r}."
        )
    if requested > MAX_CALL_DURATION_CAP_SECONDS:
        raise ValueError(
            f"max_call_duration_seconds={requested!r} exceeds the "
            f"{MAX_CALL_DURATION_CAP_SECONDS}s cap on a-leg calls. A-leg mode "
            f"dials numbers this account does not own; the cap bounds spend and "
            f"is not per-call overridable."
        )
    return int(requested)


def mint_stream_nonce() -> str:
    """Mint a fresh per-call media-stream nonce from the OS CSPRNG."""
    return secrets.token_hex(STREAM_NONCE_BYTES)


def nonce_matches(expected: str, received: Optional[str]) -> bool:
    """Timing-safe compare of a received nonce against the minted one.

    A missing/empty ``received`` never matches: the caller enforces on adapter
    state (a-leg mode minted a nonce), not on the frame carrying one, so
    omitting the ``<Parameter>`` is a rejection rather than a bypass.

    Compared as UTF-8 BYTES, not as ``str``: ``compare_digest`` raises
    ``TypeError`` on a non-ASCII ``str``, so a socket sending ``{"nonce":"é"}``
    would otherwise turn this auth primitive into an exception that unwinds
    through the media loop instead of a rejection. Mirrors the JS twin, which
    has always compared buffers.
    """
    if not received:
        return False
    return secrets.compare_digest(expected.encode("utf-8"), received.encode("utf-8"))


def escape_xml_attr(value: str) -> str:
    """Escape a string for interpolation into an XML attribute value.

    Twin of the JS ``escapeXmlAttr`` (``twilio-shared.ts``) — the two SDKs must
    emit byte-identical TwiML, so the escaping table is shared as well.
    """
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def validate_e164(phone_number: str) -> None:
    """Raise ValueError if phone_number is not a valid E.164 number.

    The message redacts the offending number: ``place_call`` validates BEFORE
    the allowlist check, so a mistyped external destination would otherwise
    reach logs in full while every other Twilio failure path redacts. The
    format hint already tells the caller what shape was expected.
    """
    if not E164_RE.match(phone_number):
        raise ValueError(
            f"phone_number {_redact_e164(phone_number)} is not in E.164 format "
            f"(expected e.g. '+14155551234', pattern: leading '+' then 7–15 digits)."
        )


def normalize_e164(phone_number: str) -> str:
    """Validate a phone number and return its canonical comparison form.

    Allowlist membership is decided on the value this returns, on BOTH sides of
    the comparison, so a match is an exact set lookup. Never compare raw
    strings with ``in``/``startswith``: "+1415555" is a prefix of a real
    allowlisted number and must not pass.
    """
    stripped = phone_number.strip()
    validate_e164(stripped)
    return stripped


class TunnelNotReadyError(RuntimeError):
    """Raised when the public base URL is not yet reachable from the edge.

    A-leg origination hands Twilio our public URL and Twilio opens the media
    WebSocket against it within seconds. If the tunnel edge is not live yet the
    call connects to nothing: the caller pays for a dead PSTN call that ends in
    a confusing stream-connect timeout. Failing fast under a named error before
    origination is the cheaper failure.
    """


@runtime_checkable
class TunnelReadiness(Protocol):
    """Anything that can tell us our public URL is reachable from the edge.

    Structurally satisfied by ``scenario.voice.testing.CloudflareTunnel`` — the
    adapter never imports the tunnel (``testing`` depends on ``adapters``, not
    the other way round), it just calls the method the tunnel already has.
    """

    async def wait_until_edge_reachable(self) -> None:
        """Return once the public edge answers; raise if it will not."""


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
    #: ``start.customParameters`` — the <Parameter> children of <Stream>. Carries
    #: the a-leg per-call nonce; empty for every other event and for b-leg.
    custom_parameters: dict[str, str] = field(default_factory=dict)


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

    if event == "start":
        raw_params = start.get("customParameters")
        custom = (
            {
                name: value
                for name, value in raw_params.items()
                if isinstance(name, str) and isinstance(value, str)
            }
            if isinstance(raw_params, dict)
            else {}
        )
        return MediaStreamEvent(
            event="start",
            stream_sid=stream_sid,
            call_sid=call_sid,
            custom_parameters=custom,
        )

    if event in {"connected", "stop"}:
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


def stream_ws_url(public_base_url: str) -> str:
    """Derive the Media Streams WebSocket URL from the adapter's public base URL.

    ``https://`` → ``wss://`` (``http://`` → ``ws://``), trailing slash
    stripped, ``/twilio/stream`` appended. Single source of truth for the
    string-munging: both the inbound webhook (``_twilio_server.py``) and the
    A-leg origination TwiML (``twilio.place_call``) route through here.
    """
    return (
        public_base_url.replace("https://", "wss://").replace("http://", "ws://")
        .rstrip("/")
        + "/twilio/stream"
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

    def place_call(
        self,
        *,
        to: str,
        from_: str,
        twiml: str,
        time_limit: Optional[int] = None,
    ) -> str:
        """Originate an outbound call. Returns the call SID.

        ``time_limit`` is Twilio's own maximum call duration in seconds
        (``TimeLimit`` on the wire). Twilio hangs the call up when it elapses,
        which is the ONLY duration guard that still fires if this process hangs
        or is killed — the adapter-side timer is the second belt. Omitted from
        the request entirely when ``None``, so b-leg origination bodies stay
        byte-identical to what they have always been.

        ``twiml`` is inline TwiML run when the call connects. The
        adapter always builds the inline form (an A-leg ``<Say>`` +
        ``<Pause>`` while the B-leg attaches the Media Stream); no
        production path passes an external URL.

        Historically this method accepted a ``twiml_url`` parameter that
        let Twilio fetch TwiML from an arbitrary URL. That formed a
        latent SSRF-via-Twilio risk: if a caller ever passed an
        attacker-controlled URL, Twilio would server-side fetch it on
        the caller's behalf. No active caller ever needed it, so it was
        removed.
        """
        extra = {} if time_limit is None else {"time_limit": time_limit}
        call = self._client.calls.create(to=to, from_=from_, twiml=twiml, **extra)
        # Twilio always returns non-None sid for create results; see above.
        return str(call.sid)

    def end_call(self, call_sid: str) -> None:
        """Hang up an in-progress call (REST ``Status=completed``).

        The adapter-side max-duration timer's teardown action (#762 guardrail
        (b)). Uses the same ``calls(sid).update(...)`` idiom as
        ``send_dtmf_on_call``, but ends the call outright instead of replacing
        its TwiML.
        """
        self._client.calls(call_sid).update(status="completed")

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

    def find_conference_sid(self, friendly_name: str) -> Optional[str]:
        """Look up the in-progress conference SID by FriendlyName.

        Two-leg conference demos use a shared room name. Returns the SID of
        the in-progress conference if found, else None (the conference
        may not be created yet — caller can retry).
        """
        for conf in self._client.conferences.list(
            friendly_name=friendly_name, status="in-progress", limit=1
        ):
            return str(conf.sid)
        return None

    def announce_to_conference(
        self,
        *,
        conference_sid: str,
        audio_url: str,
    ) -> None:
        """Broadcast ``audio_url`` audio to ALL participants in a conference.

        ``conferences/{sid}`` PATCH with ``announce_url`` causes Twilio's
        conference bridge to fetch the URL and play its audio into the
        room — every connected participant hears it. This is the standard
        way to inject programmatic audio into a Twilio conference.

        For two-leg demos where adapter A wants to "speak" so adapter B
        hears it: A renders its audio chunk to a WAV asset hosted on its
        local FastAPI app (publicly reachable via the cloudflared tunnel),
        then calls this to broadcast that URL into the shared conference.
        """
        self._client.conferences(conference_sid).update(
            announce_url=audio_url, announce_method="GET"
        )


__all__ = [
    "TWILIO_SAMPLE_RATE",
    "PCM16_SAMPLE_RATE",
    "TWILIO_FRAME_BYTES",
    "E164_RE",
    "DTMF_RE",
    "STREAM_NONCE_BYTES",
    "STREAM_NONCE_HEX_LEN",
    "MAX_CALL_DURATION_CAP_SECONDS",
    "DEFAULT_MAX_CALL_DURATION_SECONDS",
    "resolve_max_call_duration",
    "validate_e164",
    "normalize_e164",
    "validate_dtmf",
    "TunnelNotReadyError",
    "TunnelReadiness",
    "mint_stream_nonce",
    "nonce_matches",
    "escape_xml_attr",
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

def _redact_e164(number: str) -> str:
    """Redact an E.164 phone number for logs: ``+14155551234`` → ``***1234``.

    GitHub Actions retains workflow logs for 14 days and uploads on
    failure, so emitting full phone numbers at INFO would leak PII into
    a retention sink. The last-4 form is enough for operators to
    correlate ``rejected`` events without exposing the full number.

    Safety: extracts last-4 *digits* (not last-4 characters) so short or
    malformed inputs (e.g. ``+123`` from an unvalidated webhook ``From``
    field) cannot leak the leading ``+`` or country-code fragments.
    Inputs with fewer than 4 digits are fully redacted to ``***``.
    """
    if not number:
        return "***"
    digits = "".join(ch for ch in number if ch.isdigit())
    if len(digits) >= 4:
        return f"***{digits[-4:]}"
    return "***"
