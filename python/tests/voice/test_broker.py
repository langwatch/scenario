"""
Minting a voice session.

The subject is the contract between an adapter and whatever answers the
vendor's base URL: which key mints, what the socket then dials with, how the
adapter learns a gateway brokered the call, and what closes the spend record.
Money depends on all four, so each is asserted rather than inferred from a
connection succeeding.

Mirrors ``javascript/src/voice/__tests__/broker.test.ts``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import httpx
import pytest

from scenario.voice.broker import (
    ELEVENLABS_SIGNED_URL_PATH,
    MINT_TIMEOUT_S,
    REALTIME_MINT_PATH,
    USAGE_REPORT_TIMEOUT_S,
    ElevenLabsMintEndpoint,
    RealtimeMintEndpoint,
    VoiceGatewayFallbackWarning,
    VoiceGatewayMintError,
    mint_elevenlabs_signed_url,
    mint_openai_realtime_session,
    normalize_elevenlabs_base_url,
    report_openai_realtime_usage,
    resolve_elevenlabs_mint_endpoint,
    resolve_realtime_mint_endpoint,
    warn_direct_dial_fallback,
)


ENV_KEYS = (
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_REALTIME_API_KEY",
    "ELEVENLABS_BASE_URL",
    "ELEVENLABS_API_KEY",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch):
    """Every case states its own environment, so none inherits the shell's."""
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def recording_transport(
    handler,
) -> tuple[httpx.MockTransport, List[httpx.Request]]:
    """A transport that answers with ``handler`` and keeps every request."""
    seen: List[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return httpx.MockTransport(_handle), seen


def json_response(
    status: int, body: Dict[str, Any], session_id: Optional[str] = None
) -> httpx.Response:
    headers = {"content-type": "application/json"}
    if session_id is not None:
        headers["x-langwatch-session-id"] = session_id
    return httpx.Response(status, content=json.dumps(body), headers=headers)


# ------------------------------------------------- resolving where to mint


class TestResolveRealtimeMintEndpoint:
    """The environment scenario already uses for chat is the whole config."""

    def test_unset_base_url_mints_at_openai(self, monkeypatch: pytest.MonkeyPatch):
        # The mint path is OpenAI's own, so the vendor answers it too.
        monkeypatch.setenv("OPENAI_API_KEY", "sk-provider")

        assert resolve_realtime_mint_endpoint() == RealtimeMintEndpoint(
            base_url="https://api.openai.com/v1", api_key="sk-provider"
        )

    def test_gateway_base_url_needs_nothing_else(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OPENAI_BASE_URL", "https://gateway.example/v1/")
        monkeypatch.setenv("OPENAI_API_KEY", "vk-lw-test")

        assert resolve_realtime_mint_endpoint() == RealtimeMintEndpoint(
            base_url="https://gateway.example/v1", api_key="vk-lw-test"
        )

    def test_explicit_arguments_beat_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OPENAI_BASE_URL", "https://from-env.example/v1")
        monkeypatch.setenv("OPENAI_API_KEY", "vk-from-env")

        assert resolve_realtime_mint_endpoint(
            base_url="https://explicit.example/v1", api_key="vk-explicit"
        ) == RealtimeMintEndpoint(
            base_url="https://explicit.example/v1", api_key="vk-explicit"
        )

    def test_realtime_key_alone_does_not_mint(self, monkeypatch: pytest.MonkeyPatch):
        # OPENAI_REALTIME_API_KEY holds a direct provider key. Minting with it
        # would present a gateway a credential it did not issue and cannot
        # bill, and the refusal would read as a gateway outage.
        monkeypatch.setenv("OPENAI_BASE_URL", "https://gateway.example/v1")
        monkeypatch.setenv("OPENAI_REALTIME_API_KEY", "sk-real-provider-key")

        assert resolve_realtime_mint_endpoint() is None


class TestNormalizeElevenLabsBaseUrl:
    def test_empty_means_unset(self):
        assert normalize_elevenlabs_base_url(None) is None
        assert normalize_elevenlabs_base_url("  ") is None

    def test_trailing_slash_is_dropped(self):
        assert (
            normalize_elevenlabs_base_url("https://gateway.example/")
            == "https://gateway.example"
        )

    def test_v1_suffix_is_refused(self):
        # This module appends /v1 itself, so a base URL carrying it would
        # request /v1/v1/convai/... and 404 with no cause named.
        with pytest.raises(ValueError, match="must not include /v1"):
            normalize_elevenlabs_base_url("https://gateway.example/v1")

    def test_non_http_scheme_is_refused(self):
        # urlparse accepts schemes no REST request can be made over, so
        # parsing alone is not a check.
        with pytest.raises(ValueError, match="must be http or https"):
            normalize_elevenlabs_base_url("wss://gateway.example")


class TestResolveElevenLabsMintEndpoint:
    def test_unset_base_url_leaves_the_adapter_on_its_direct_dial(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # ElevenLabs defines no base-URL variable of its own, so an
        # unconfigured adapter must connect exactly as it always has.
        monkeypatch.setenv("ELEVENLABS_API_KEY", "xi-provider")

        assert resolve_elevenlabs_mint_endpoint() is None

    def test_environment_base_url_points_the_mint_at_a_gateway(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("ELEVENLABS_BASE_URL", "https://gateway.example/")
        monkeypatch.setenv("ELEVENLABS_API_KEY", "vk-lw-test")

        assert resolve_elevenlabs_mint_endpoint() == ElevenLabsMintEndpoint(
            base_url="https://gateway.example", api_key="vk-lw-test"
        )

    def test_no_key_means_no_mint(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("ELEVENLABS_BASE_URL", "https://gateway.example")

        assert resolve_elevenlabs_mint_endpoint() is None


# ------------------------------------------------------ the realtime mint

ENDPOINT = RealtimeMintEndpoint(
    base_url="https://gateway.example/v1", api_key="vk-lw-test"
)


class TestMintOpenAIRealtimeSession:
    @pytest.mark.asyncio
    async def test_sends_the_key_and_reads_back_the_secret_and_session_id(self):
        transport, seen = recording_transport(
            lambda _r: json_response(
                200, {"value": "ek_abc", "expires_at": 1}, session_id="req_123"
            )
        )

        result = await mint_openai_realtime_session(
            ENDPOINT, "gpt-realtime", transport=transport
        )

        assert result.minted is True
        assert result.credential == "ek_abc"
        assert result.session_id == "req_123"
        assert str(seen[0].url) == f"https://gateway.example/v1{REALTIME_MINT_PATH}"
        assert seen[0].headers["authorization"] == "Bearer vk-lw-test"
        assert json.loads(seen[0].content) == {
            "session": {"type": "realtime", "model": "gpt-realtime"}
        }

    @pytest.mark.asyncio
    async def test_expiry_is_sent_only_when_asked_for(self):
        transport, seen = recording_transport(
            lambda _r: json_response(200, {"value": "ek_abc"})
        )

        await mint_openai_realtime_session(
            ENDPOINT, "gpt-realtime", expires_after_seconds=600, transport=transport
        )

        assert json.loads(seen[0].content)["expires_after"] == {
            "anchor": "created_at",
            "seconds": 600,
        }

    @pytest.mark.asyncio
    async def test_vendor_answer_carries_no_session_id(self):
        # This is how the adapter learns what it is talking to. OpenAI's own
        # mint carries no such header, so there is nothing to report usage to
        # and nothing that would accept a report.
        transport, _ = recording_transport(
            lambda _r: json_response(200, {"value": "ek_from_openai"})
        )

        result = await mint_openai_realtime_session(
            ENDPOINT, "gpt-realtime", transport=transport
        )

        assert result.minted is True
        assert result.session_id == ""

    @pytest.mark.asyncio
    async def test_absent_route_is_reported_rather_than_raised(self):
        # A plain proxy, or a LangWatch gateway older than this feature,
        # answers 404 here. That is an absence, not a refusal, so the caller
        # may dial the vendor directly.
        transport, _ = recording_transport(
            lambda _r: httpx.Response(404, text="not found")
        )

        result = await mint_openai_realtime_session(
            ENDPOINT, "gpt-realtime", transport=transport
        )

        assert result.minted is False
        assert result.status == 404

    @pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
    @pytest.mark.asyncio
    async def test_a_refusal_raises_so_it_cannot_be_dialled_around(
        self, status: int
    ):
        # The endpoint HAS the route and declined to use it: a rejected key, a
        # budget, a session cap, an outage. Falling back would run exactly the
        # call the gateway refused to bill.
        transport, _ = recording_transport(
            lambda _r: json_response(
                status,
                {
                    "error": {
                        "code": "realtime_session_limit",
                        "message": "this virtual key already holds the most "
                        "voice sessions",
                    }
                },
            )
        )

        with pytest.raises(VoiceGatewayMintError) as excinfo:
            await mint_openai_realtime_session(
                ENDPOINT, "gpt-realtime", transport=transport
            )

        message = str(excinfo.value)
        assert f"HTTP {status}" in message
        assert "refused the mint" in message
        assert "realtime_session_limit" in message

    @pytest.mark.asyncio
    async def test_a_mint_with_no_credential_is_refused(self):
        transport, _ = recording_transport(
            lambda _r: json_response(200, {"expires_at": 1})
        )

        with pytest.raises(VoiceGatewayMintError, match="no client secret"):
            await mint_openai_realtime_session(
                ENDPOINT, "gpt-realtime", transport=transport
            )

    @pytest.mark.asyncio
    async def test_a_nested_client_secret_is_still_read(self):
        # OpenAI has previously nested the credential, so both shapes are read
        # rather than pinning the adapter to one release.
        transport, _ = recording_transport(
            lambda _r: json_response(200, {"client_secret": {"value": "ek_nested"}})
        )

        result = await mint_openai_realtime_session(
            ENDPOINT, "gpt-realtime", transport=transport
        )

        assert result.credential == "ek_nested"

    @pytest.mark.asyncio
    async def test_a_body_that_is_not_json_is_refused(self):
        transport, _ = recording_transport(
            lambda _r: httpx.Response(200, text="<html>gateway</html>")
        )

        with pytest.raises(VoiceGatewayMintError, match="not JSON"):
            await mint_openai_realtime_session(
                ENDPOINT, "gpt-realtime", transport=transport
            )

    @pytest.mark.asyncio
    async def test_a_stalled_endpoint_gives_up_rather_than_leaving_connect_pending(
        self,
    ):
        # connect() waits for the mint before it opens the socket, so an
        # unbounded request leaves connection setup pending forever and the
        # caller never learns why.
        def stall(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("stalled")

        transport, _ = recording_transport(stall)

        with pytest.raises(httpx.TimeoutException):
            await mint_openai_realtime_session(
                ENDPOINT, "gpt-realtime", transport=transport, timeout_s=0.05
            )

    def test_the_mint_bound_is_finite(self):
        # A default of None would make the request unbounded, which is the
        # failure the timeout exists to prevent.
        assert 0 < MINT_TIMEOUT_S < 60


# ------------------------------------------------ the ElevenLabs signed URL

EL_ENDPOINT = ElevenLabsMintEndpoint(
    base_url="https://gateway.example", api_key="vk-lw-test"
)


class TestMintElevenLabsSignedUrl:
    @pytest.mark.asyncio
    async def test_sends_the_key_and_reads_back_the_signed_url_and_session_id(self):
        transport, seen = recording_transport(
            lambda _r: json_response(
                200, {"signed_url": "wss://vendor.example/x?token=y"},
                session_id="req_el",
            )
        )

        result = await mint_elevenlabs_signed_url(
            EL_ENDPOINT, "agent_abc", transport=transport
        )

        assert result.minted is True
        assert result.credential == "wss://vendor.example/x?token=y"
        assert result.session_id == "req_el"
        assert seen[0].url.path == ELEVENLABS_SIGNED_URL_PATH
        assert seen[0].url.params["agent_id"] == "agent_abc"
        # xi-api-key is the vendor's own header, and the gateway reads it too,
        # so one request shape reaches either.
        assert seen[0].headers["xi-api-key"] == "vk-lw-test"

    @pytest.mark.asyncio
    async def test_absent_route_is_reported_rather_than_raised(self):
        transport, _ = recording_transport(
            lambda _r: httpx.Response(404, text="404 page not found")
        )

        result = await mint_elevenlabs_signed_url(
            EL_ENDPOINT, "agent_abc", transport=transport
        )

        assert result.minted is False
        assert result.status == 404

    @pytest.mark.parametrize("status", [401, 403, 429, 500])
    @pytest.mark.asyncio
    async def test_a_refusal_raises_so_it_cannot_be_dialled_around(
        self, status: int
    ):
        transport, _ = recording_transport(
            lambda _r: json_response(status, {"error": "budget_exceeded"})
        )

        with pytest.raises(VoiceGatewayMintError) as excinfo:
            await mint_elevenlabs_signed_url(
                EL_ENDPOINT, "agent_abc", transport=transport
            )

        message = str(excinfo.value)
        assert f"HTTP {status}" in message
        assert "refused the mint" in message

    @pytest.mark.asyncio
    async def test_a_mint_with_no_signed_url_is_refused(self):
        transport, _ = recording_transport(
            lambda _r: json_response(200, {"agent_id": "agent_abc"})
        )

        with pytest.raises(VoiceGatewayMintError, match="no signed_url"):
            await mint_elevenlabs_signed_url(
                EL_ENDPOINT, "agent_abc", transport=transport
            )


# ---------------------------------------------- the usage report at the end


class TestReportOpenAIRealtimeUsage:
    @pytest.mark.asyncio
    async def test_posts_the_vendor_usage_object_against_the_session_id(self):
        transport, seen = recording_transport(lambda _r: httpx.Response(202))

        error = await report_openai_realtime_usage(
            ENDPOINT,
            "req_123",
            {"input_tokens": 15, "output_tokens": 43},
            transport=transport,
        )

        assert error is None
        assert (
            str(seen[0].url)
            == "https://gateway.example/v1/realtime/sessions/req_123/usage"
        )
        assert json.loads(seen[0].content) == {
            "usage": {"input_tokens": 15, "output_tokens": 43}
        }

    @pytest.mark.asyncio
    async def test_sends_nothing_when_the_vendor_minted_the_session(self):
        transport, seen = recording_transport(lambda _r: httpx.Response(202))

        error = await report_openai_realtime_usage(
            ENDPOINT, "", {"input_tokens": 1}, transport=transport
        )

        assert error is None
        assert seen == []

    @pytest.mark.asyncio
    async def test_a_refusal_is_returned_because_a_rejected_report_is_not_a_delivered_one(
        self,
    ):
        # A 404 for an unknown session, or a 401 for a rotated key, answers,
        # so nothing raises. Reading only the raised case would treat both as
        # a report that landed, and the session would settle as cost-unknown
        # with nobody told why.
        transport, _ = recording_transport(lambda _r: httpx.Response(404, text="no"))

        error = await report_openai_realtime_usage(
            ENDPOINT, "req_123", {"input_tokens": 1}, transport=transport
        )

        assert error is not None
        assert "HTTP 404" in str(error)

    @pytest.mark.asyncio
    async def test_never_raises_because_billing_must_not_fail_the_test_it_measures(
        self,
    ):
        # The session still settles: the gateway closes an unreported
        # admission as cost-unknown once its grace expires.
        def unreachable(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("gateway unreachable")

        transport, _ = recording_transport(unreachable)

        error = await report_openai_realtime_usage(
            ENDPOINT, "req_123", {"input_tokens": 1}, transport=transport
        )

        assert isinstance(error, httpx.ConnectError)

    @pytest.mark.asyncio
    async def test_gives_up_on_a_stalled_gateway_rather_than_holding_the_socket(
        self,
    ):
        # disconnect() awaits this, so an unbounded request keeps the
        # websocket open and the test that owns it never finishes.
        def stall(_request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("stalled")

        transport, _ = recording_transport(stall)

        error = await report_openai_realtime_usage(
            ENDPOINT,
            "req_123",
            {"input_tokens": 1},
            transport=transport,
            timeout_s=0.05,
        )

        assert isinstance(error, httpx.TimeoutException)

    def test_the_usage_report_bound_is_short(self):
        # It is awaited inside disconnect(), so a generous bound would show up
        # as a hang at the end of every run.
        assert 0 < USAGE_REPORT_TIMEOUT_S <= 10


class TestWarnDirectDialFallback:
    def test_the_fallback_is_loud(self):
        # A silent fall back to a direct key looks exactly like a successful
        # brokered run while producing no spend record at all, so a run that
        # proved nothing would read as a run that proved everything.
        with pytest.warns(VoiceGatewayFallbackWarning) as record:
            warn_direct_dial_fallback(
                "https://gateway.example/v1",
                REALTIME_MINT_PATH,
                "OPENAI_API_KEY",
            )

        message = str(record[0].message)
        assert "https://gateway.example/v1/realtime/client_secrets" in message
        assert "OPENAI_API_KEY" in message
        assert "not billed" in message
