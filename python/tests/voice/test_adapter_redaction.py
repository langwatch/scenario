"""
Verifies credential-carrying adapters redact secrets in their __repr__.

If any logging / tracing layer serialises str(adapter) or vars(adapter), we
must not leak API keys, auth tokens, etc.
"""

from scenario.voice import ElevenLabsAgentAdapter, LiveKitAgentAdapter, TwilioAgentAdapter, VapiAgentAdapter


def test_twilio_repr_redacts_auth_token_and_account_sid():
    a = TwilioAgentAdapter(
        account_sid="AC_real_secret_sid",
        auth_token="real_auth_token",
        phone_number="+14155551234",
    )
    r = repr(a)
    assert "+14155551234" in r  # phone numbers are not secret
    assert "AC_real_secret_sid" not in r
    assert "real_auth_token" not in r
    assert r.count("***") >= 2


def test_livekit_repr_redacts_api_key_and_secret():
    a = LiveKitAgentAdapter(url="wss://x", api_key="k_secret", api_secret="s_secret", room="R")
    r = repr(a)
    assert "k_secret" not in r
    assert "s_secret" not in r
    assert "R" in r  # room name is not secret


def test_elevenlabs_repr_redacts_api_key():
    a = ElevenLabsAgentAdapter(agent_id="ag_123", api_key="secret_el_key")
    r = repr(a)
    assert "ag_123" in r
    assert "secret_el_key" not in r


def test_vapi_repr_redacts_api_key():
    a = VapiAgentAdapter(assistant_id="asst_123", api_key="secret_vapi_key")
    r = repr(a)
    assert "asst_123" in r
    assert "secret_vapi_key" not in r
