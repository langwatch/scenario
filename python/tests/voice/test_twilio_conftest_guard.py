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
        _require_twilio_env(_TWILIO_REQUIRED_KEYS, auth_ok)
    except pytest.skip.Exception as exc:
        return "skipped", str(exc)
    except pytest.fail.Exception as exc:
        return "failed", str(exc)
    # No exception -> the guard let the test proceed. The helper is
    # procedure-like (it signals via pytest.skip/fail and always returns None),
    # so we don't inspect its return value — inspecting it trips the
    # "use of a procedure's return value" code-quality check.
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


def test_partial_env_skips_and_names_only_the_missing_keys(monkeypatch):
    """Only 2 of 4 keys set -> still a skip (any missing key triggers it),
    and the skip message names ONLY the missing keys (not the present ones) so
    the operator knows exactly what to configure. Indexes the constant rather
    than hardcoding key names so the test can't silently go stale if the
    required-key set changes."""
    absent = _TWILIO_REQUIRED_KEYS[:2]
    present = _TWILIO_REQUIRED_KEYS[2:]
    for key in absent:
        monkeypatch.delenv(key, raising=False)
    for key in present:
        monkeypatch.setenv(key, "+15550001111")

    kind, message = _outcome(lambda: True)
    assert kind == "skipped"
    assert message is not None  # narrow for type-checkers; skip path always has a message
    for key in absent:
        assert key in message, f"skip message should name missing key {key}"
    # ...and ONLY the missing keys: catches a `", ".join(missing)` -> `join(keys)`
    # mutation that would name present keys too (containment alone would miss it).
    for key in present:
        assert key not in message, f"skip message should not name present key {key}"


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


# ---------------------------------------------------------------- fixture wiring

def test_twilio_fixtures_delegate_to_the_guard():
    """The tests above pin the guard's logic; this pins that the *fixtures*
    actually route through it. A fixture silently reverting to the old
    fail-on-absent gate would reintroduce the #796 dispatch abort while every
    test above stays green — only source inspection catches that. Mirrors the
    `requires_transport_ready` probe precedent in conftest (inspect the source,
    don't call the fixture — pytest forbids calling fixtures directly)."""
    import inspect

    from tests.voice import conftest

    for fixture_name in ("requires_twilio_outbound", "requires_twilio_inbound"):
        fixture = getattr(conftest, fixture_name)
        # @pytest.fixture may wrap the function; unwrap to the real body.
        func = getattr(fixture, "__wrapped__", fixture)
        source = inspect.getsource(func)
        assert "_require_twilio_env" in source, (
            f"{fixture_name} no longer delegates to _require_twilio_env — the "
            "#796 skip-on-absent gate may have regressed"
        )
        assert "_twilio_auth_ok" in source, (
            f"{fixture_name} no longer passes the _twilio_auth_ok probe"
        )
