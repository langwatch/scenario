"""Issue #768: pin the Twilio wrapper harness to the real ``connect()`` state.

The media-stream wrapper tests use ``make_connected_twilio_adapter()``, which
hand-builds the state that production ``TwilioAgentAdapter.connect()`` creates.
This test keeps that shortcut honest by comparing it with a real connect while
faking only the Twilio SDK client construction boundary.
"""

from typing import Any

import pytest

from scenario.voice import TwilioAgentAdapter
from scenario.voice.adapters._twilio_shared import TwilioRESTHelper
from scenario.voice.testing.wrapper_harness import make_connected_twilio_adapter


def _connected_state_shape(adapter: TwilioAgentAdapter) -> dict[str, Any]:
    """Return the harness-managed state in a form comparable across adapters."""
    inbound_queue = adapter._inbound_queue
    stream_connected = adapter._stream_connected
    server_shutdown = adapter._server_shutdown
    webhook_server = getattr(adapter, "_webhook_server", None)

    return {
        # The harness deliberately uses an object() sentinel because its media
        # path only needs the adapter's connectedness check to see a value.
        "_rest": adapter._rest is not None,
        "_inbound_queue": (
            type(inbound_queue),
            inbound_queue.maxsize,
            inbound_queue.empty(),
        )
        if inbound_queue is not None
        else None,
        "_stream_connected": (
            type(stream_connected),
            stream_connected.is_set(),
        )
        if stream_connected is not None
        else None,
        "_server_shutdown": (
            type(server_shutdown),
            server_shutdown.is_set(),
        )
        if server_shutdown is not None
        else None,
        "_webhook_server": (
            type(webhook_server),
            getattr(webhook_server, "_adapter", None) is adapter,
        )
        if webhook_server is not None
        else None,
    }


@pytest.mark.asyncio
async def test_wrapper_harness_connected_state_matches_real_connect(
    monkeypatch: pytest.MonkeyPatch,
):
    """The listed harness-managed fields must drift-fail against ``connect()``.

    ``twilio.rest.Client`` is the only fake boundary. The production adapter,
    REST helper, connect method, webhook server, queues, and events are real.
    """
    captured: dict[str, Any] = {}
    phone_number_sid = "PN" + "7" * 32

    class _FakeIncomingPhoneNumbers:
        def list(self, *, phone_number: str, limit: int) -> list[Any]:
            captured["phone_number"] = phone_number
            captured["limit"] = limit

            class _Record:
                sid = phone_number_sid

            return [_Record()]

    class _FakeTwilioClient:
        def __init__(self, account_sid: str, auth_token: str) -> None:
            captured["account_sid"] = account_sid
            captured["auth_token"] = auth_token
            self.incoming_phone_numbers = _FakeIncomingPhoneNumbers()

    monkeypatch.setattr("twilio.rest.Client", _FakeTwilioClient)

    account_sid = "AC" + "7" * 32
    auth_token = "test-token-not-real"
    phone_number = "+14155550196"
    real_adapter = TwilioAgentAdapter(
        account_sid=account_sid,
        auth_token=auth_token,
        phone_number=phone_number,
        public_base_url="https://example768.invalid",
        # The test never connects to the route, so let the OS assign the port
        # atomically instead of using free_port()'s reserve-release race.
        http_port=0,
        validate_signature=False,
    )
    harness_adapter = make_connected_twilio_adapter()

    try:
        await real_adapter.connect()
        assert captured == {
            "account_sid": account_sid,
            "auth_token": auth_token,
            "phone_number": phone_number,
            "limit": 1,
        }
        assert isinstance(real_adapter._rest, TwilioRESTHelper)
        assert real_adapter._phone_number_sid == phone_number_sid
        # This outer task proves connect() scheduled the server lifecycle; the
        # inner uvicorn task owns readiness and is intentionally not inferred here.
        assert real_adapter._server_task is not None
        assert _connected_state_shape(real_adapter) == _connected_state_shape(
            harness_adapter
        )
    finally:
        await real_adapter.disconnect()
