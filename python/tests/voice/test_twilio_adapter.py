"""
Unit tests for TwilioAgentAdapter transport behavior (REST client mocked).

Real-phone e2e is covered in examples/voice_twilio_*_scenario.py.
"""

import asyncio
from typing import Any

import pytest

from scenario.voice import TwilioAgentAdapter


def _make_adapter(**overrides: Any) -> TwilioAgentAdapter:
    kwargs: dict[str, Any] = dict(
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


# ---------------------------------------------------------------- FakeREST test double

class FakeREST:
    """In-memory stand-in for TwilioRESTHelper, recording every mutation."""

    def __init__(self, account_sid: str = "", auth_token: str = "") -> None:
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.write_calls: list[tuple[str, str]] = []
        self.place_call_kwargs: list[dict[str, Any]] = []
        self._prior_voice_url = "https://old-webhook.example.com/previous"

    def resolve_phone_number_sid(self, number: str) -> str:
        return "PN" + "0" * 32

    def read_voice_url(self, sid: str) -> str:
        return self._prior_voice_url

    def write_voice_url(self, sid: str, url: str) -> None:
        self.write_calls.append((sid, url))

    def place_call(self, *, to: str, from_: str, twiml_url: str) -> str:
        self.place_call_kwargs.append({"to": to, "from_": from_, "twiml_url": twiml_url})
        return "CA" + "1" * 32

    def send_dtmf_on_call(self, call_sid: str, tones: str) -> None:
        pass


def _install_fake_rest(monkeypatch: Any) -> list[FakeREST]:
    """Patch the REST helper and suppress the uvicorn server task. Returns the
    list that collects every FakeREST instance constructed."""
    rest_instances: list[FakeREST] = []

    def _factory(account_sid: str, auth_token: str) -> FakeREST:
        r = FakeREST(account_sid, auth_token)
        rest_instances.append(r)
        return r

    monkeypatch.setattr("scenario.voice.adapters.twilio.TwilioRESTHelper", _factory)

    async def _fake_run_server(self: Any) -> None:
        return

    monkeypatch.setattr(TwilioAgentAdapter, "_run_server", _fake_run_server)
    return rest_instances


# ---------------------------------------------------------------- connect/disconnect

@pytest.mark.asyncio
async def test_connect_requires_public_base_url():
    a = _make_adapter(public_base_url=None)
    with pytest.raises(RuntimeError, match="public_base_url"):
        await a.connect()


@pytest.mark.asyncio
async def test_connect_resolves_sid_without_touching_voice_url(monkeypatch):
    """connect() resolves the SID + starts the server, but does NOT overwrite
    the Twilio number's voice_url. That's the job of wait_for_call() (answer
    mode). Caller-mode adapters must leave the number alone."""
    rest_instances = _install_fake_rest(monkeypatch)

    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._phone_number_sid == "PN" + "0" * 32
        assert a._mode == "idle"
        assert rest_instances[0].write_calls == [], (
            "connect() must not write voice_url; that's wait_for_call()'s job"
        )
    finally:
        await a.disconnect()
        # Nothing to restore — we never wrote — so write_calls stays empty.
        assert rest_instances[0].write_calls == []


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


# ---------------------------------------------------------------- caller/answerer mode

@pytest.mark.asyncio
async def test_place_call_transitions_to_call_mode(monkeypatch):
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._mode == "idle"
        # Pre-fire the stream-connected event so place_call returns instead of
        # blocking — we're testing mode transition, not the WS handshake.
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")
        assert a._mode == "call"
        assert len(rest_instances[0].place_call_kwargs) == 1
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_wait_for_call_transitions_to_answer_mode(monkeypatch):
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._mode == "idle"
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.wait_for_call(timeout=1.0)
        assert a._mode == "answer"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_wait_for_call_then_place_call_raises(monkeypatch):
    _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.wait_for_call(timeout=1.0)
        with pytest.raises(RuntimeError, match="already in 'answer' mode"):
            await a.place_call(to="+14155557777")
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_place_call_then_wait_for_call_raises(monkeypatch):
    _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")
        with pytest.raises(RuntimeError, match="already in 'call' mode"):
            await a.wait_for_call(timeout=1.0)
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_place_call_does_not_modify_voice_url(monkeypatch):
    """Caller mode must not touch the Twilio number's inbound webhook.

    This lets teams run caller-mode adapters against a shared pool of Twilio
    numbers without clobbering anyone's prod configuration.
    """
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")
        assert rest_instances[0].write_calls == [], (
            "caller mode must not write voice_url"
        )
    finally:
        await a.disconnect()
        # Nothing to restore either — the whole session was write-free.
        assert rest_instances[0].write_calls == []


@pytest.mark.asyncio
async def test_wait_for_call_writes_and_restores_voice_url(monkeypatch):
    """Answer mode is the only mode that mutates the Twilio account."""
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.wait_for_call(timeout=1.0)
        # Exactly one write on mode entry.
        rest = rest_instances[0]
        assert len(rest.write_calls) == 1
        sid, url = rest.write_calls[0]
        assert sid == "PN" + "0" * 32
        assert url.endswith("/twilio/voice")
    finally:
        await a.disconnect()
        # Second write on disconnect restores the prior URL.
        assert rest_instances[0].write_calls[-1] == (
            "PN" + "0" * 32,
            "https://old-webhook.example.com/previous",
        )


@pytest.mark.asyncio
async def test_place_call_passes_twiml_url_to_rest(monkeypatch):
    rest_instances = _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        assert a._stream_connected is not None
        a._stream_connected.set()
        await a.place_call(to="+14155557777")
        kw = rest_instances[0].place_call_kwargs[0]
        assert kw["to"] == "+14155557777"
        assert kw["from_"] == "+14155551234"
        assert kw["twiml_url"] == "https://example.trycloudflare.com/twilio/voice"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_place_call_timeout_raises(monkeypatch):
    """If Twilio never opens the media stream back to us, place_call times out."""
    _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        # Don't set _stream_connected — place_call will wait and time out.
        with pytest.raises(asyncio.TimeoutError):
            await a.place_call(to="+14155557777", timeout=0.05)
        # Mode stuck in "call" after timeout — retry would be idempotent but
        # switching to answer after a failed call is still disallowed.
        assert a._mode == "call"
    finally:
        await a.disconnect()


@pytest.mark.asyncio
async def test_place_call_rejects_non_e164_target(monkeypatch):
    _install_fake_rest(monkeypatch)
    a = _make_adapter(http_port=0)
    await a.connect()
    try:
        with pytest.raises(ValueError, match="E.164"):
            await a.place_call(to="4155551234")  # missing leading '+'
    finally:
        await a.disconnect()


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
