"""
What the adapters do with a minted session.

The broker's own contract is covered in ``test_broker.py``. The subject here
is the handoff: that the ephemeral credential the mint returned is what
reaches the socket, that a long-lived key does not, that an absent mint route
falls back loudly, and that a refused mint stops the connection instead of
dialling the vendor around it.
"""

from __future__ import annotations

import importlib
import json
from typing import Any, Dict, List, Optional

import httpx
import pytest

from scenario.voice.adapters.elevenlabs import ElevenLabsAgentAdapter
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter
from scenario.voice.broker import (
    ElevenLabsMintEndpoint,
    RealtimeMintEndpoint,
    VoiceGatewayFallbackWarning,
    VoiceGatewayMintError,
)


GATEWAY = RealtimeMintEndpoint(
    base_url="https://gateway.example/v1", api_key="vk-lw-test"
)
EL_GATEWAY = ElevenLabsMintEndpoint(
    base_url="https://gateway.example", api_key="vk-lw-test"
)


class FakeSocket:
    """Records what the adapter sent, and replays what it should receive."""

    def __init__(self, inbound: Optional[List[Dict[str, Any]]] = None) -> None:
        self.sent: List[Dict[str, Any]] = []
        self._inbound = list(inbound or [])
        self.closed = False

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def recv(self) -> str:
        if not self._inbound:
            raise AssertionError("FakeSocket: nothing left to receive")
        return json.dumps(self._inbound.pop(0))

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_ws(monkeypatch: pytest.MonkeyPatch):
    """Replaces the real websocket dial, and captures its URL and headers."""
    import websockets

    calls: List[Dict[str, Any]] = []
    socket = FakeSocket()

    async def _connect(url: str, additional_headers=None, **_kwargs):
        calls.append({"url": url, "headers": dict(additional_headers or {})})
        return socket

    monkeypatch.setattr(websockets, "connect", _connect)
    return {"calls": calls, "socket": socket}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch):
    for key in (
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_REALTIME_API_KEY",
        "ELEVENLABS_BASE_URL",
        "ELEVENLABS_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)


def mint_transport(response_for) -> httpx.MockTransport:
    return httpx.MockTransport(response_for)


#: Which adapter module imported each broker function, so the test patches
#: the name the adapter actually calls rather than the one it was defined on.
BROKER_CALLERS = {
    "mint_openai_realtime_session": "openai_realtime",
    "report_openai_realtime_usage": "openai_realtime",
    "close_unused_realtime_session": "openai_realtime",
    "mint_elevenlabs_signed_url": "elevenlabs",
}


def patch_mint(monkeypatch: pytest.MonkeyPatch, name: str, transport) -> None:
    """Give the adapter's broker call a transport, leaving its behaviour whole.

    The real function still runs; only the socket underneath it is replaced.
    Stubbing the function instead would test the stub.

    The original is read off the adapter module rather than the broker module,
    so the thing wrapped here is exactly the object the adapter will call.
    """
    module = importlib.import_module(
        f"scenario.voice.adapters.{BROKER_CALLERS[name]}"
    )
    original = getattr(module, name)

    async def _with_transport(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return await original(*args, **kwargs)

    monkeypatch.setattr(module, name, _with_transport)


class TestRealtimeAdapterMint:
    @pytest.mark.asyncio
    async def test_the_socket_dials_with_the_ephemeral_secret_not_the_long_lived_key(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        transport = mint_transport(
            lambda _r: httpx.Response(
                200,
                json={"value": "ek_ephemeral"},
                headers={"x-langwatch-session-id": "req_123"},
            )
        )
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-long-lived", mint=GATEWAY)

        await adapter.connect()

        assert fake_ws["calls"][0]["headers"]["Authorization"] == "Bearer ek_ephemeral"
        assert "sk-long-lived" not in json.dumps(fake_ws["calls"][0])
        assert adapter.brokered is True

    @pytest.mark.asyncio
    async def test_a_vendor_mint_leaves_the_adapter_unbrokered(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        # Only a gateway names the session it opened, so an answer without the
        # header means there is no spend record to report against.
        transport = mint_transport(
            lambda _r: httpx.Response(200, json={"value": "ek_from_openai"})
        )
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)

        await adapter.connect()

        assert adapter.brokered is False

    @pytest.mark.asyncio
    async def test_an_absent_mint_route_falls_back_loudly(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        transport = mint_transport(lambda _r: httpx.Response(404, text="not found"))
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)

        with pytest.warns(VoiceGatewayFallbackWarning):
            await adapter.connect()

        assert fake_ws["calls"][0]["headers"]["Authorization"] == "Bearer sk-provider"
        assert adapter.brokered is False

    @pytest.mark.parametrize("status", [401, 403, 429, 500])
    @pytest.mark.asyncio
    async def test_a_refused_mint_never_reaches_the_vendor(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws, status: int
    ):
        # This is the whole point of brokering. Dialling the vendor with a
        # direct provider key after the gateway declined would run the call
        # the gateway refused to bill, off budget and off the ledger.
        transport = mint_transport(
            lambda _r: httpx.Response(status, json={"error": "budget_exceeded"})
        )
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)

        with pytest.raises(VoiceGatewayMintError, match="refused the mint"):
            await adapter.connect()

        assert fake_ws["calls"] == []

    @pytest.mark.asyncio
    async def test_mint_false_dials_the_vendor_with_no_mint_request(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        # An unconfigured adapter must connect exactly as it always has.
        def refuse(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("mint=False must not make a mint request")

        patch_mint(
            monkeypatch, "mint_openai_realtime_session", mint_transport(refuse)
        )
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=False)

        await adapter.connect()

        assert fake_ws["calls"][0]["headers"]["Authorization"] == "Bearer sk-provider"
        assert adapter.brokered is False

    @pytest.mark.asyncio
    async def test_a_session_whose_socket_never_opened_is_closed_at_zero(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # The mint booked it and only a report can close it. Leaving it open
        # would hold one of the key's session slots and book a call that never
        # happened.
        posted: List[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            if request.url.path.endswith("/usage"):
                return httpx.Response(202)
            return httpx.Response(
                200,
                json={"value": "ek_ephemeral"},
                headers={"x-langwatch-session-id": "req_dead"},
            )

        transport = mint_transport(handle)
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        patch_mint(monkeypatch, "close_unused_realtime_session", transport)

        import websockets

        async def _refuse(*_args, **_kwargs):
            raise ConnectionRefusedError("socket refused")

        monkeypatch.setattr(websockets, "connect", _refuse)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)

        with pytest.raises(ConnectionRefusedError):
            await adapter.connect()

        usage_posts = [r for r in posted if r.url.path.endswith("/usage")]
        assert len(usage_posts) == 1
        assert usage_posts[0].url.path == "/v1/realtime/sessions/req_dead/usage"
        # The zeros are stated, not left out. A gateway reads a usage report
        # by looking for input_tokens or output_tokens and refuses a body
        # carrying neither, so an empty object is answered with HTTP 400 and
        # the session stays open until its grace expires.
        assert json.loads(usage_posts[0].content) == {
            "usage": {"input_tokens": 0, "output_tokens": 0}
        }

    @pytest.mark.asyncio
    async def test_disconnect_reports_what_the_socket_measured(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        posted: List[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            if request.url.path.endswith("/usage"):
                return httpx.Response(202)
            return httpx.Response(
                200,
                json={"value": "ek_ephemeral"},
                headers={"x-langwatch-session-id": "req_123"},
            )

        transport = mint_transport(handle)
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        patch_mint(monkeypatch, "report_openai_realtime_usage", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)
        await adapter.connect()

        # The usage capture reads every inbound event, not only the branch the
        # audio drain takes, because a drain that ends on tail silence never
        # reaches the terminal event.
        adapter._capture_usage(
            {
                "type": "response.done",
                "response": {"usage": {"input_tokens": 15, "output_tokens": 43}},
            }
        )
        await adapter.disconnect()

        usage_posts = [r for r in posted if r.url.path.endswith("/usage")]
        assert len(usage_posts) == 1
        assert json.loads(usage_posts[0].content) == {
            "usage": {"input_tokens": 15, "output_tokens": 43}
        }

    @pytest.mark.asyncio
    async def test_a_second_disconnect_does_not_report_the_session_twice(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        posted: List[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            if request.url.path.endswith("/usage"):
                return httpx.Response(202)
            return httpx.Response(
                200,
                json={"value": "ek_ephemeral"},
                headers={"x-langwatch-session-id": "req_123"},
            )

        transport = mint_transport(handle)
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        patch_mint(monkeypatch, "report_openai_realtime_usage", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)
        await adapter.connect()
        adapter._capture_usage(
            {"type": "response.done", "response": {"usage": {"input_tokens": 1}}}
        )

        await adapter.disconnect()
        await adapter.disconnect()

        assert len([r for r in posted if r.url.path.endswith("/usage")]) == 1

    @pytest.mark.asyncio
    async def test_an_unbrokered_session_reports_nothing(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        posted: List[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            posted.append(request)
            return httpx.Response(200, json={"value": "ek_from_openai"})

        transport = mint_transport(handle)
        patch_mint(monkeypatch, "mint_openai_realtime_session", transport)
        patch_mint(monkeypatch, "report_openai_realtime_usage", transport)
        adapter = OpenAIRealtimeAgentAdapter(api_key="sk-provider", mint=GATEWAY)
        await adapter.connect()
        adapter._capture_usage(
            {"type": "response.done", "response": {"usage": {"input_tokens": 1}}}
        )

        await adapter.disconnect()

        assert [r for r in posted if r.url.path.endswith("/usage")] == []


class TestElevenLabsAdapterMint:
    @pytest.mark.asyncio
    async def test_the_socket_dials_the_signed_url_with_no_key_on_it(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        transport = mint_transport(
            lambda _r: httpx.Response(
                200,
                json={"signed_url": "wss://api.elevenlabs.io/x?token=abc"},
                headers={"x-langwatch-session-id": "req_el"},
            )
        )
        patch_mint(monkeypatch, "mint_elevenlabs_signed_url", transport)
        adapter = ElevenLabsAgentAdapter(
            agent_id="agent_abc", api_key="vk-lw-test", mint=EL_GATEWAY
        )

        await adapter.connect()

        assert fake_ws["calls"][0]["url"] == "wss://api.elevenlabs.io/x?token=abc"
        assert fake_ws["calls"][0]["headers"] == {}
        assert adapter.brokered is True

    @pytest.mark.asyncio
    async def test_an_absent_mint_route_falls_back_loudly(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        transport = mint_transport(
            lambda _r: httpx.Response(404, text="404 page not found")
        )
        patch_mint(monkeypatch, "mint_elevenlabs_signed_url", transport)
        adapter = ElevenLabsAgentAdapter(
            agent_id="agent_abc", api_key="xi-provider", mint=EL_GATEWAY
        )

        with pytest.warns(VoiceGatewayFallbackWarning):
            await adapter.connect()

        assert fake_ws["calls"][0]["url"].startswith(
            "wss://api.elevenlabs.io/v1/convai/conversation"
        )
        assert fake_ws["calls"][0]["headers"] == {"xi-api-key": "xi-provider"}
        assert adapter.brokered is False

    @pytest.mark.parametrize("status", [401, 403, 429, 500])
    @pytest.mark.asyncio
    async def test_a_refused_mint_never_reaches_the_vendor(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws, status: int
    ):
        transport = mint_transport(
            lambda _r: httpx.Response(status, json={"error": "budget_exceeded"})
        )
        patch_mint(monkeypatch, "mint_elevenlabs_signed_url", transport)
        adapter = ElevenLabsAgentAdapter(
            agent_id="agent_abc", api_key="xi-provider", mint=EL_GATEWAY
        )

        with pytest.raises(VoiceGatewayMintError, match="refused the mint"):
            await adapter.connect()

        assert fake_ws["calls"] == []

    @pytest.mark.asyncio
    async def test_an_unconfigured_adapter_connects_exactly_as_before(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        def refuse(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("an unconfigured adapter must not mint")

        patch_mint(monkeypatch, "mint_elevenlabs_signed_url", mint_transport(refuse))
        adapter = ElevenLabsAgentAdapter(agent_id="agent_abc", api_key="xi-provider")

        await adapter.connect()

        assert fake_ws["calls"][0]["url"] == adapter.url
        assert fake_ws["calls"][0]["headers"] == {"xi-api-key": "xi-provider"}
        assert adapter.brokered is False

    @pytest.mark.voice_gateway_mint
    @pytest.mark.asyncio
    async def test_the_environment_base_url_is_enough_to_broker(
        self, monkeypatch: pytest.MonkeyPatch, fake_ws
    ):
        # No bespoke broker variable: the vendor's own base URL is the switch.
        monkeypatch.setenv("ELEVENLABS_BASE_URL", "https://gateway.example")
        transport = mint_transport(
            lambda _r: httpx.Response(
                200,
                json={"signed_url": "wss://api.elevenlabs.io/x?token=abc"},
                headers={"x-langwatch-session-id": "req_el"},
            )
        )
        patch_mint(monkeypatch, "mint_elevenlabs_signed_url", transport)
        adapter = ElevenLabsAgentAdapter(agent_id="agent_abc", api_key="vk-lw-test")

        await adapter.connect()

        assert adapter.brokered is True
