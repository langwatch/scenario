"""
Regression tests for the Twilio preflight-fixture gate decided in issue #796.

Decision (option b): the Twilio fixtures must SKIP when TWILIO_* env is
ABSENT — a missing-secret CI run has to reach its later steps instead of
aborting — but FAIL when env is present-but-broken (credentials that don't
authenticate). Skip only on absence; never mask a real failure.

These tests drive `_require_twilio_env` directly rather than through the
fixtures, with `monkeypatch` controlling env so the outcome is independent of
this developer's real python/.env (which does have TWILIO_* configured).
"""

import pytest

from tests.voice.conftest import _TWILIO_REQUIRED_KEYS, _require_twilio_env


def _outcome(auth_ok):
    """Call `_require_twilio_env` and classify the result as exactly one of
    "passed" / "skipped" / "failed", plus the outcome message (None on pass).

    A bare `pytest.raises(SomeExc)` would let a *wrong-type* outcome (e.g. a
    Skipped escaping a block that expected Failed) leak past the context
    manager and get reinterpreted by pytest's own runner as this test being
    skipped rather than failed — quietly hiding a real mutation instead of
    turning it red. Classifying explicitly and asserting on a plain string
    means every wrong outcome surfaces as an ordinary AssertionError, which
    pytest always reports as FAILED, never as skipped.
    """
    try:
        result = _require_twilio_env(_TWILIO_REQUIRED_KEYS, auth_ok)
    except pytest.skip.Exception as exc:
        return "skipped", str(exc)
    except pytest.fail.Exception as exc:
        return "failed", str(exc)
    assert result is None, "helper should return None on the success path"
    return "passed", None


# ---------------------------------------------------------------- absence -> skip

def test_absent_env_skips_even_when_auth_would_pass(monkeypatch):
    """All four keys missing -> skip. Absence must dominate the decision, so
    auth_ok reporting True (it would never actually be called with no creds)
    still results in a skip, not a pass."""
    for key in _TWILIO_REQUIRED_KEYS:
        monkeypatch.delenv(key, raising=False)

    kind, _ = _outcome(lambda: True)
    assert kind == "skipped"


def test_partial_env_skips_and_names_the_missing_keys(monkeypatch):
    """Only 2 of 4 keys set -> still a skip (any missing key triggers it),
    and the skip message names the missing ones so the operator knows what
    to configure."""
    monkeypatch.delenv("TWILIO_ACCOUNT_SID", raising=False)
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("TWILIO_PHONE_NUMBER", "+15550001111")
    monkeypatch.setenv("TWILIO_PHONE_NUMBER_2", "+15550002222")

    kind, message = _outcome(lambda: True)
    assert kind == "skipped"
    assert message is not None  # narrow for type-checkers; skip path always has a message
    assert "TWILIO_ACCOUNT_SID" in message
    assert "TWILIO_AUTH_TOKEN" in message


# ---------------------------------------------------------------- present -> fail/pass

def test_present_but_broken_auth_fails_not_skips(monkeypatch):
    """All four keys present but auth_ok() reports False -> FAIL, never a
    skip. A present-but-broken credential is a real failure per #796, not
    something to quietly skip past."""
    for key in _TWILIO_REQUIRED_KEYS:
        monkeypatch.setenv(key, "dummy-value")

    kind, _ = _outcome(lambda: False)
    assert kind == "failed"


def test_present_and_valid_passes_cleanly(monkeypatch):
    """All four keys present and auth_ok() reports True -> no skip, no
    failure; the fixture lets the test proceed."""
    for key in _TWILIO_REQUIRED_KEYS:
        monkeypatch.setenv(key, "dummy-value")

    kind, _ = _outcome(lambda: True)
    assert kind == "passed"
