"""
Unit tests for TwilioAgentAdapter transport behavior (REST client mocked).

Real-phone e2e is covered in examples/voice_twilio_*_scenario.py.
"""

from unittest.mock import MagicMock, patch

import pytest

from scenario.voice import TwilioAgentAdapter


def _make_adapter(**overrides):
    kwargs = dict(
        account_sid="AC" + "0" * 32,
        auth_token="secret",
        phone_number="+14155551234",
        public_base_url="https://example.trycloudflare.com",
    )
    kwargs.update(overrides)
    return TwilioAgentAdapter(**kwargs)


# ---------------------------------------------------------------- construction

def test_constructor_validates_e164():
    with pytest.raises(ValueError, match="E.164"):
        _make_adapter(phone_number="4155551234")


def test_repr_redacts_all_three_secrets():
    a = _make_adapter()
    r = repr(a)
    assert "AC" + "0" * 32 not in r
    assert "secret" not in r
    assert "+14155551234" in r  # not a secret


def test_capabilities_match_contract():
    caps = TwilioAgentAdapter.capabilities
    assert caps.dtmf is True
    assert caps.streaming_transcripts is False
    assert caps.native_vad is False
    assert caps.input_formats == ["mulaw/8000"]
    assert caps.output_formats == ["mulaw/8000"]


# ---------------------------------------------------------------- connect/disconnect

@pytest.mark.asyncio
async def test_connect_requires_public_base_url():
    a = _make_adapter(public_base_url=None)
    with pytest.raises(RuntimeError, match="public_base_url"):
        await a.connect()


@pytest.mark.asyncio
async def test_connect_resolves_sid_and_registers_webhook(monkeypatch):
    # Mock the REST helper so we don't hit Twilio.
    rest_instances = []

    class FakeREST:
        def __init__(self, account_sid, auth_token):
            self.account_sid = account_sid
            self.auth_token = auth_token
            self.write_calls: list[tuple[str, str]] = []
            rest_instances.append(self)

        def resolve_phone_number_sid(self, number):
            return "PN" + "0" * 32

        def read_voice_url(self, sid):
            return "https://old-webhook.example.com/previous"

        def write_voice_url(self, sid, url):
            self.write_calls.append((sid, url))

    # Replace both the import in _twilio_shared and in the adapter module.
    monkeypatch.setattr("scenario.voice.adapters.twilio.TwilioRESTHelper", FakeREST)

    # Prevent the FastAPI server from actually binding a port.
    async def _fake_run_server(self):
        return

    monkeypatch.setattr(TwilioAgentAdapter, "_run_server", _fake_run_server)

    a = _make_adapter(http_port=0)  # port 0 = never bound, fine for this test
    await a.connect()
    try:
        assert a._phone_number_sid == "PN" + "0" * 32
        assert a._prior_voice_url == "https://old-webhook.example.com/previous"
        # Webhook was written on connect.
        rest = rest_instances[0]
        assert len(rest.write_calls) == 1
        sid, url = rest.write_calls[0]
        assert sid == "PN" + "0" * 32
        assert url.endswith("/twilio/voice")
        assert url.startswith("https://example.trycloudflare.com")
    finally:
        await a.disconnect()
        # Disconnect should write the prior URL back.
        assert rest_instances[0].write_calls[-1] == (
            "PN" + "0" * 32,
            "https://old-webhook.example.com/previous",
        )


@pytest.mark.asyncio
async def test_send_dtmf_without_active_call_raises():
    a = _make_adapter()
    with pytest.raises(RuntimeError, match="active call"):
        await a.send_dtmf("1")


@pytest.mark.asyncio
async def test_send_audio_without_active_stream_raises():
    from scenario.voice import AudioChunk

    a = _make_adapter()
    with pytest.raises(RuntimeError, match="not connected"):
        await a.send_audio(AudioChunk(data=b"\x00\x00" * 100))


# ---------------------------------------------------------------- dtmf callback

def test_on_dtmf_callback_stored():
    received: list[str] = []

    def handler(digit: str) -> None:
        received.append(digit)

    a = _make_adapter(on_dtmf=handler)
    assert a.on_dtmf is handler


def test_allowed_callers_normalized_to_set():
    a = _make_adapter(allowed_callers=["+14155551234", "+14155557777"])
    assert a.allowed_callers == {"+14155551234", "+14155557777"}
