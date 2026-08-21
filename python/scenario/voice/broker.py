"""
Minting a voice session, at the vendor or at a gateway in front of it.

``POST /v1/realtime/client_secrets`` is OpenAI's own path, and
``GET /v1/convai/conversation/get-signed-url`` is ElevenLabs'. A LangWatch AI
Gateway mirrors both: it checks the virtual key's budget and its open-session
cap, mints the vendor's own short-lived credential, and opens one spend record
for the call. The media socket still runs client to vendor in both cases, so
latency and the wire protocol are unchanged.

That symmetry is the whole design. Each adapter reads the variables its vendor
already defines and mints at the same path either way. Point them at the vendor
and the mint happens at the vendor with a provider key. Point them at a gateway
and the mint happens through the broker with a virtual key. There is no third
URL, no third key, and no branch on who is answering.

Port of ``javascript/src/voice/broker.ts``; the two SDKs keep the same
semantics on purpose.
"""

from __future__ import annotations

import logging
import os
import warnings
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import quote, urlparse

import httpx


logger = logging.getLogger("scenario.voice.broker")

#: The vendor's default, used when ``OPENAI_BASE_URL`` is unset.
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

#: The vendor's default, used when ``ELEVENLABS_BASE_URL`` is unset.
ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io"

REALTIME_MINT_PATH = "/realtime/client_secrets"
ELEVENLABS_SIGNED_URL_PATH = "/v1/convai/conversation/get-signed-url"

#: A gateway names the session it opened on this response header. The vendors
#: do not, which is how an adapter learns what answered.
SESSION_ID_HEADER = "x-langwatch-session-id"

#: How long a mint may take before it is abandoned.
#:
#: ``connect()`` waits for this before it opens the socket, so an unbounded
#: request leaves connection setup pending forever against a stalled endpoint.
#: Generous rather than tight: a mint is a real round trip to a vendor, and a
#: session refused for slowness costs a call that would have worked.
MINT_TIMEOUT_S = 15.0

#: How long a usage report may take before it is abandoned.
#:
#: ``disconnect()`` awaits the report, so an unbounded request holds the socket
#: open and the test that owns it never finishes. A report is worth a few
#: seconds and never worth a hang: the session still settles on the gateway's
#: own grace if it never arrives.
USAGE_REPORT_TIMEOUT_S = 5.0


class VoiceGatewayFallbackWarning(RuntimeWarning):
    """A mint route was absent, so the adapter dialled the vendor directly.

    Raised as a warning rather than logged only, because pytest prints its
    warnings summary on every run while it hides log records of passing tests.
    A run that fell back produced no spend record at all, so the difference
    has to reach the CI log.
    """


class VoiceGatewayMintError(RuntimeError):
    """The endpoint has a mint route and refused to mint.

    Distinct from an absent route on purpose. An absence may be dialled
    around; a refusal may not, because dialling the vendor with a direct
    provider key would run exactly the call the gateway declined to bill.
    """


@dataclass(frozen=True)
class RealtimeMintEndpoint:
    """Where an OpenAI Realtime mint request goes, and the key it carries."""

    #: OpenAI-compatible base URL, including ``/v1``, without a trailing slash.
    base_url: str
    #: The key the endpoint authenticates: a provider key, or a virtual key.
    api_key: str


@dataclass(frozen=True)
class ElevenLabsMintEndpoint:
    """Where an ElevenLabs signed-URL request goes, and the key it carries."""

    #: ElevenLabs-compatible base URL, WITHOUT ``/v1``, no trailing slash.
    base_url: str
    #: The key the endpoint authenticates: a provider key, or a virtual key.
    api_key: str


@dataclass(frozen=True)
class MintResult:
    """What a mint attempt produced.

    ``session_id`` is empty unless a gateway answered, because only a gateway
    carries :data:`SESSION_ID_HEADER`. An empty id therefore means the vendor
    minted the credential itself and there is no session to report usage to.

    ``status`` is meaningful only when ``minted`` is false, where it is always
    404: every other refusal raises rather than returning.
    """

    minted: bool
    #: The vendor credential: an ``ek_...`` client secret, or a ``wss://``
    #: signed URL. Empty when ``minted`` is false.
    credential: str = ""
    session_id: str = ""
    status: int = 0


def resolve_realtime_mint_endpoint(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[RealtimeMintEndpoint]:
    """Resolve where to mint an OpenAI Realtime session, or ``None``.

    ``None`` means there is no key to mint with, so the caller dials the
    vendor directly.

    ``OPENAI_REALTIME_API_KEY`` is deliberately not consulted here. That
    variable holds a direct provider key for the socket, and presenting it to
    a gateway would offer a credential the gateway did not issue and cannot
    bill. It stays what it already was: the fallback for dialling the vendor
    directly.
    """
    key = api_key or os.environ.get("OPENAI_API_KEY") or ""
    if not key:
        return None
    resolved_base = (
        base_url or os.environ.get("OPENAI_BASE_URL") or OPENAI_DEFAULT_BASE_URL
    )
    return RealtimeMintEndpoint(base_url=resolved_base.rstrip("/"), api_key=key)


def normalize_elevenlabs_base_url(raw: Optional[str]) -> Optional[str]:
    """Check an ElevenLabs base URL at construction, where the mistake is
    still readable.

    The one people make is including ``/v1``. ``OPENAI_BASE_URL``
    conventionally does, and this module appends ``/v1`` itself, so a base URL
    that carries it would request ``/v1/v1/convai/...`` and return a 404 that
    names no cause. An empty value means unset.
    """
    trimmed = (raw or "").strip().rstrip("/")
    if not trimmed:
        return None
    parsed = urlparse(trimmed)
    if parsed.scheme not in ("http", "https"):
        # A value that parses is not therefore a value a REST request can be
        # made over, so parsing alone is not a check.
        raise ValueError(
            f"ElevenLabs base URL must be http or https: {trimmed}"
        )
    if not parsed.netloc:
        raise ValueError(f"ElevenLabs base URL is not a URL: {trimmed}")
    if parsed.path.endswith("/v1"):
        raise ValueError(
            f"ElevenLabs base URL must not include /v1 ({trimmed}). "
            "The adapter appends it, so this would request "
            "/v1/v1/convai/... and 404."
        )
    return trimmed


def resolve_elevenlabs_mint_endpoint(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[ElevenLabsMintEndpoint]:
    """Resolve where to mint an ElevenLabs signed URL, or ``None``.

    ``None`` means no base URL is configured, which leaves the adapter on its
    existing direct dial to the vendor's own websocket. The base URL IS the
    configuration here: ElevenLabs defines no environment variable for it, so
    ``ELEVENLABS_BASE_URL`` is scenario's own name for the same option the
    official SDKs expose as a client argument.
    """
    resolved_base = normalize_elevenlabs_base_url(
        base_url if base_url is not None else os.environ.get("ELEVENLABS_BASE_URL")
    )
    if not resolved_base:
        return None
    key = api_key or os.environ.get("ELEVENLABS_API_KEY") or ""
    if not key:
        return None
    return ElevenLabsMintEndpoint(base_url=resolved_base, api_key=key)


async def mint_openai_realtime_session(
    endpoint: RealtimeMintEndpoint,
    model: str,
    *,
    expires_after_seconds: Optional[int] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout_s: Optional[float] = None,
) -> MintResult:
    """Mint a realtime session, and report whether the route existed.

    A 404 means the base URL points at something with no mint route: plain
    OpenAI without the path, a third-party proxy, or a LangWatch gateway older
    than this feature. That is an absence, so the caller may fall back to
    dialling the vendor directly.

    Any other error status is a refusal by an endpoint that DOES have the
    route: a rejected key, an exhausted budget, a session cap, an outage.
    Those raise. Falling back on a refusal would spend a direct provider key
    on a call the gateway just declined to bill, which defeats the whole point
    of minting through it.
    """
    body: Dict[str, Any] = {"session": {"type": "realtime", "model": model}}
    if expires_after_seconds is not None:
        body["expires_after"] = {
            "anchor": "created_at",
            "seconds": expires_after_seconds,
        }

    response = await _request(
        "POST",
        f"{endpoint.base_url}{REALTIME_MINT_PATH}",
        headers={
            "Authorization": f"Bearer {endpoint.api_key}",
            "Content-Type": "application/json",
        },
        json_body=body,
        transport=transport,
        timeout_s=timeout_s if timeout_s is not None else MINT_TIMEOUT_S,
    )

    if response.status_code == 404:
        return MintResult(minted=False, status=404)
    _raise_if_refused(response, endpoint.base_url, "realtime mint")

    parsed = _parse_json(response, "realtime mint")
    client_secret = _read_client_secret(parsed)
    if not client_secret:
        raise VoiceGatewayMintError("realtime mint returned no client secret")
    return MintResult(
        minted=True,
        credential=client_secret,
        session_id=_session_id(response),
    )


async def mint_elevenlabs_signed_url(
    endpoint: ElevenLabsMintEndpoint,
    agent_id: str,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout_s: Optional[float] = None,
) -> MintResult:
    """Mint an ElevenLabs ConvAI signed URL, and report whether the route
    existed.

    Same split as :func:`mint_openai_realtime_session`: 404 is an absent
    route the caller may dial around, and every other error status is a
    refusal that raises.

    The key travels as ``xi-api-key`` because that is the vendor's own header,
    and the gateway reads it too, so one request shape reaches either.
    """
    response = await _request(
        "GET",
        f"{endpoint.base_url}{ELEVENLABS_SIGNED_URL_PATH}"
        f"?agent_id={quote(agent_id, safe='')}",
        headers={"xi-api-key": endpoint.api_key},
        json_body=None,
        transport=transport,
        timeout_s=timeout_s if timeout_s is not None else MINT_TIMEOUT_S,
    )

    if response.status_code == 404:
        return MintResult(minted=False, status=404)
    _raise_if_refused(response, endpoint.base_url, "ElevenLabs signed-URL mint")

    parsed = _parse_json(response, "ElevenLabs signed-URL mint")
    signed_url = parsed.get("signed_url")
    if not isinstance(signed_url, str) or not signed_url:
        raise VoiceGatewayMintError(
            "ElevenLabs signed-URL mint returned no signed_url"
        )
    return MintResult(
        minted=True,
        credential=signed_url,
        session_id=_session_id(response),
    )


async def report_openai_realtime_usage(
    endpoint: RealtimeMintEndpoint,
    session_id: str,
    usage: Dict[str, Any],
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout_s: Optional[float] = None,
) -> Optional[BaseException]:
    """Report what the socket measured, closing the session's spend record.

    OpenAI reports usage over the socket, in ``response.done``, and that
    socket runs client to vendor, so this is the only path by which those
    numbers reach a gateway. A session that never reports is not lost: the
    gateway settles it as cost-unknown once its grace expires.

    Never raises. A failed report costs accuracy on one session, and raising
    here would fail a test whose subject is the agent, not the billing. The
    failure is RETURNED instead, so a caller that wants to log it can, and
    ``None`` means the report landed.
    """
    # No session id means the vendor minted this credential, so there is no
    # spend record anywhere to close.
    if not session_id:
        return None
    try:
        response = await _request(
            "POST",
            f"{endpoint.base_url}/realtime/sessions/"
            f"{quote(session_id, safe='')}/usage",
            headers={
                "Authorization": f"Bearer {endpoint.api_key}",
                "Content-Type": "application/json",
            },
            json_body={"usage": usage},
            transport=transport,
            timeout_s=(
                timeout_s if timeout_s is not None else USAGE_REPORT_TIMEOUT_S
            ),
        )
    except BaseException as error:  # noqa: BLE001 - reported, never raised
        return error
    # A refused report is a failure that answers. Reading only the raised case
    # would treat a 404 for an unknown session, or a 401 for a rotated key, as
    # a report that landed, and the session would settle as cost-unknown with
    # nobody told why.
    if response.status_code >= 400:
        return VoiceGatewayMintError(
            f"realtime usage report refused with HTTP {response.status_code}"
        )
    return None


def warn_direct_dial_fallback(
    base_url: str,
    mint_path: str,
    credential_source: str,
) -> None:
    """Warn that a mint route was absent and a direct provider key is in use.

    Loud on purpose. A silent fall back to a direct key looks exactly like a
    successful brokered run while producing no spend record at all, so a test
    run that proved nothing would read as a run that proved everything.

    ``credential_source`` names where the key being dialled came from, because
    an adapter reads several in order and naming a fixed one sends the reader
    to a variable that is not set.
    """
    message = (
        f"voice mint route not found at {base_url}{mint_path}; dialling the "
        f"vendor directly with {credential_source}. This session is not "
        f"billed or budgeted by the gateway at {base_url}."
    )
    logger.warning(message)
    # stacklevel=2 puts the warning on the adapter's connect(), which is the
    # line a reader can act on.
    warnings.warn(message, VoiceGatewayFallbackWarning, stacklevel=2)


# --------------------------------------------------------------------- internals


async def _request(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Optional[Dict[str, Any]],
    transport: Optional[httpx.AsyncBaseTransport],
    timeout_s: float,
) -> httpx.Response:
    """One HTTP round trip, bounded, over a client the caller may replace.

    ``transport`` is the injection seam the tests use (``httpx.MockTransport``);
    the timeout still comes from the client built here, so a test can prove the
    bound is the module's and not its own.
    """
    async with httpx.AsyncClient(
        transport=transport, timeout=httpx.Timeout(timeout_s)
    ) as client:
        return await client.request(method, url, headers=headers, json=json_body)


def _raise_if_refused(response: httpx.Response, base_url: str, what: str) -> None:
    """Raise unless the endpoint minted.

    Reached only after 404 has been handled, so every status here belongs to
    an endpoint that HAS the route and declined to use it. 401 and 403 are a
    rejected key, 429 a session cap or rate limit, 5xx an outage. All of them
    mean the gateway refused this session, and none of them may be dialled
    around.
    """
    if response.status_code < 400:
        return
    detail = response.text[:500]
    raise VoiceGatewayMintError(
        f"{what} refused with HTTP {response.status_code}: the gateway at "
        f"{base_url} refused the mint, so this session must not fall back to "
        f"a direct provider key. {detail}"
    )


def _parse_json(response: httpx.Response, what: str) -> Dict[str, Any]:
    try:
        parsed = response.json()
    except Exception as error:  # noqa: BLE001 - the body itself is the fault
        raise VoiceGatewayMintError(
            f"{what} returned a body that is not JSON"
        ) from error
    if not isinstance(parsed, dict):
        raise VoiceGatewayMintError(f"{what} returned a body that is not JSON")
    return parsed


def _session_id(response: httpx.Response) -> str:
    return response.headers.get(SESSION_ID_HEADER, "") or ""


def _read_client_secret(body: Dict[str, Any]) -> str:
    """The credential, wherever the mint put it.

    OpenAI returns ``{"value": ...}`` at the top level today and has
    previously nested it under ``client_secret``, so both are read rather than
    pinning the adapter to one release's shape.
    """
    value = body.get("value")
    if isinstance(value, str) and value:
        return value
    nested = body.get("client_secret")
    if isinstance(nested, dict):
        nested_value = nested.get("value")
        if isinstance(nested_value, str) and nested_value:
            return nested_value
    return ""
