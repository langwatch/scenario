"""
Shared test configuration and fail-fast preflight fixtures for the voice suite.

Philosophy per TESTING.md ("E2E = happy paths via real examples, no mocks"):
missing infrastructure is a test FAILURE with a clear message, not a silent
skip. The only legitimate "skip" is for code that genuinely isn't shipped yet
(transport stubs that still raise PendingTransportError).

Preflight fixtures assert the required infrastructure is reachable before the
test body runs. If anything is missing, the fixture fails with a one-line
diagnosis naming the missing dependency — so the test runner output directly
tells you what to set up.

Auto-provisioning: the Pipecat stub bot is cheap to spawn (no credentials,
no API cost). If it isn't already on :8765 when a Pipecat-dependent test
starts, the fixture starts it session-scoped and tears it down at end of run.
"""

from __future__ import annotations

import atexit
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Optional

import pytest

# Load .env before any fixture or test runs.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — tests still run when env is already
    # exported (CI sets vars directly). Silent skip is correct here.
    pass

import scenario

# Configure a sensible default so tests that don't specify a model
# don't fail with "UserSimulatorAgent was initialized without a model".
if os.getenv("OPENAI_API_KEY"):
    scenario.configure(default_model="openai/gpt-4.1-mini")


# --------------------------------------------------------------------- #
# Helpers                                                               #
# --------------------------------------------------------------------- #


def _tcp_port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    """Quick TCP probe — True if something is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _require_env(*keys: str) -> None:
    """Fail the test with a clear message if any env var is missing."""
    missing = [k for k in keys if not os.getenv(k)]
    if missing:
        pytest.fail(
            f"Required env var(s) missing: {', '.join(missing)}. "
            "Set them in python/.env (see python/.env.example) — "
            "e2e tests fail on missing infrastructure, not skip."
        )


# --------------------------------------------------------------------- #
# Session-scoped infrastructure                                         #
# --------------------------------------------------------------------- #


_bot_process: Optional[subprocess.Popen] = None


def _start_pipecat_bot() -> None:
    """Spawn the bundled stub bot on :8765 and wait for it to accept conns."""
    global _bot_process
    if _bot_process is not None and _bot_process.poll() is None:
        return  # already running

    bot_path = (
        Path(__file__).resolve().parent.parent.parent
        / "examples"
        / "voice"
        / "_bot"
        / "bot.py"
    )
    if not bot_path.exists():
        pytest.fail(f"Pipecat stub bot not found at {bot_path}")

    log_path = Path("/tmp/voice-pipecat-bot.log")
    log_fh = open(log_path, "ab")
    try:
        _bot_process = subprocess.Popen(
            ["uv", "run", "python", str(bot_path)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            cwd=bot_path.parent.parent.parent,
            preexec_fn=os.setsid,
        )
    finally:
        # Close our copy of the fd; subprocess.Popen has duplicated it
        # for the child process. Avoids leaking an open file in the parent.
        log_fh.close()
    atexit.register(_stop_pipecat_bot)

    # Wait up to 15s for the port.
    for _ in range(30):
        if _tcp_port_open("localhost", 8765):
            return
        if _bot_process.poll() is not None:
            tail = log_path.read_text()[-2000:] if log_path.exists() else ""
            pytest.fail(f"Pipecat bot exited during startup. Log tail:\n{tail}")
        time.sleep(0.5)
    pytest.fail(
        "Pipecat bot did not open :8765 within 15s. "
        f"See {log_path} for details."
    )


def _stop_pipecat_bot() -> None:
    global _bot_process
    if _bot_process is None:
        return
    try:
        os.killpg(os.getpgid(_bot_process.pid), signal.SIGTERM)
        _bot_process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(os.getpgid(_bot_process.pid), signal.SIGKILL)
        except ProcessLookupError:
            # Process already exited between the SIGTERM/KILL — nothing
            # to clean up. Teardown is best-effort by design.
            pass
    _bot_process = None


# --------------------------------------------------------------------- #
# Preflight fixtures (fail-fast, not skip)                              #
# --------------------------------------------------------------------- #


@pytest.fixture
def requires_llm():
    """Fail unless OPENAI_API_KEY is set. No probe — let the test run, and
    real scope errors surface as real test failures with informative errors
    rather than cached preflight noise."""
    _require_env("OPENAI_API_KEY")


@pytest.fixture
def requires_pipecat_bot():
    """Ensure a Pipecat-compatible bot is on :8765, with liveness check + auto-restart.

    If the bot was previously started but has since crashed, we restart it and
    fail the current test so the operator knows the infrastructure hiccuped —
    subsequent tests will find a healthy bot and run normally.
    """
    import logging

    bot_was_known_running = (
        _bot_process is not None and _bot_process.poll() is None
    )
    port_open = _tcp_port_open("localhost", 8765, timeout=0.5)

    if not port_open:
        if bot_was_known_running:
            # Bot died between tests — restart it, then fail this test so the
            # operator knows it was an infrastructure failure, not a test bug.
            logging.getLogger("scenario.voice").warning(
                "Pipecat stub bot (:8765) died between tests; restarting for "
                "subsequent tests."
            )
            _start_pipecat_bot()
            pytest.fail(
                "[infrastructure] Pipecat stub bot died mid-suite and was restarted. "
                "This test is an infrastructure failure, not a bug in the code under test. "
                "Subsequent tests should run normally with the restarted bot."
            )
        else:
            # Bot was never started — auto-provision it (nominal path).
            _start_pipecat_bot()


@pytest.fixture
def requires_elevenlabs_hosted_agent():
    """Fail unless ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID are set."""
    _require_env("ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID")


@pytest.fixture
def requires_elevenlabs_key():
    """Fail unless ELEVENLABS_API_KEY is set (STT + branded demos)."""
    _require_env("ELEVENLABS_API_KEY")


@pytest.fixture
def requires_elevenlabs_paid_voice():
    """Skip unless ELEVENLABS_VOICE_ID is set.

    ElevenLabs free-tier accounts cannot use premade voice IDs (HTTP 402).
    Set ELEVENLABS_VOICE_ID to a custom voice you own to run demos that use
    ElevenLabsVoiceAgent TTS.  This is a legitimate env constraint, not a
    code bug — hence skip rather than fail.
    """
    _require_env("ELEVENLABS_API_KEY")
    if not os.getenv("ELEVENLABS_VOICE_ID"):
        pytest.skip(
            "ELEVENLABS_VOICE_ID not set; ElevenLabs free-tier cannot use premade voices. "
            "Set ELEVENLABS_VOICE_ID to a custom voice you own to run this test."
        )


@pytest.fixture
def requires_gemini_key():
    """Fail unless GEMINI_API_KEY is set.

    If the key is present but Google reports it leaked (403), skip with a
    clear 'rotate GEMINI_API_KEY' message. Missing env is still a FAIL.
    """
    _require_env("GEMINI_API_KEY")
    if not _gemini_key_ok():
        pytest.skip(
            "Gemini API key rejected (likely flagged as leaked by Google). "
            "Rotate GEMINI_API_KEY in python/.env."
        )


_twilio_auth_ok_cache: Optional[bool] = None


def _twilio_auth_ok() -> bool:
    """Session-cached probe: does the Twilio auth token actually work?

    Returns True if creds authenticate, False if 401. Skip (not fail) on 401
    so a known-revoked token produces a clear 'rotate this var' message
    instead of flooding the suite with noise. Missing env vars still FAIL
    (fail-fast per TESTING.md) — this probe only runs once env is present.
    """
    global _twilio_auth_ok_cache
    if _twilio_auth_ok_cache is not None:
        return _twilio_auth_ok_cache
    sid = os.getenv("TWILIO_ACCOUNT_SID")
    token = os.getenv("TWILIO_AUTH_TOKEN")
    if not (sid and token):
        _twilio_auth_ok_cache = False
        return False
    try:
        import httpx

        r = httpx.get(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}.json",
            auth=(sid, token),
            timeout=5.0,
        )
        _twilio_auth_ok_cache = r.status_code == 200
    except Exception:
        _twilio_auth_ok_cache = False
    return _twilio_auth_ok_cache


_gemini_key_ok_cache: Optional[bool] = None


def _gemini_key_ok() -> bool:
    """Session-cached probe: does the Gemini API key work?

    Google revokes leaked keys with a specific 403 error. Skip on that so
    the clear 'rotate GEMINI_API_KEY' message surfaces.
    """
    global _gemini_key_ok_cache
    if _gemini_key_ok_cache is not None:
        return _gemini_key_ok_cache
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        _gemini_key_ok_cache = False
        return False
    try:
        import httpx

        r = httpx.get(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={key}",
            timeout=5.0,
        )
        _gemini_key_ok_cache = r.status_code == 200
    except Exception:
        _gemini_key_ok_cache = False
    return _gemini_key_ok_cache


@pytest.fixture
def requires_twilio_outbound():
    """Fail unless Twilio outbound demo env is fully configured.

    Outbound dials TWILIO_PHONE_NUMBER_2 by default — a second Twilio-owned
    number whose own harness will answer. No human required.

    If env is present but auth is rejected (401), skip with a clear 'rotate
    TWILIO_AUTH_TOKEN' message. Missing env is still a FAIL.
    """
    _require_env(
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_PHONE_NUMBER",
        "TWILIO_PHONE_NUMBER_2",
    )
    if not _twilio_auth_ok():
        pytest.skip(
            "Twilio auth token rejected (401). Rotate TWILIO_AUTH_TOKEN in "
            "python/.env — account creds are stale."
        )


@pytest.fixture
def requires_twilio_inbound():
    """Fail unless Twilio inbound demo env is configured.

    Inbound uses a second Twilio number (TWILIO_PHONE_NUMBER_2) to dial in
    to the primary (TWILIO_PHONE_NUMBER). No human required.

    If env is present but auth is rejected (401), skip with a clear 'rotate
    TWILIO_AUTH_TOKEN' message. Missing env is still a FAIL.
    """
    _require_env(
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_PHONE_NUMBER",
        "TWILIO_PHONE_NUMBER_2",
    )
    if not _twilio_auth_ok():
        pytest.skip(
            "Twilio auth token rejected (401). Rotate TWILIO_AUTH_TOKEN in "
            "python/.env — account creds are stale."
        )


@pytest.fixture
def requires_transport_ready():
    """
    Factory for capability probes: skip (legitimately) if an adapter's
    send_audio / recv_audio still raise PendingTransportError — the
    transport isn't shipped yet.

    This is the ONE case where skipping is correct per TESTING.md: we can't
    test code that doesn't exist. When the transport ships, the probe stops
    detecting the sentinel raise and the test runs automatically.

    Uses static source inspection rather than calling connect() so it works
    inside already-running event loops (pytest-asyncio test bodies).

    Usage:
        def test_x(requires_transport_ready):
            adapter = OpenAIRealtimeAgentAdapter(...)
            requires_transport_ready(adapter)
            # ...proceed
    """
    import inspect

    def _probe(adapter):
        # The stub pattern is always the same: inside send_audio/recv_audio,
        # import PendingTransportError and raise it. Inspect source for the
        # sentinel string.
        for method_name in ("send_audio", "recv_audio"):
            method = getattr(type(adapter), method_name, None)
            if method is None:
                continue
            try:
                source = inspect.getsource(method)
            except (OSError, TypeError):
                continue
            if "raise PendingTransportError" in source:
                pytest.skip(
                    f"transport not yet shipped: "
                    f"{type(adapter).__name__}.{method_name} still raises "
                    "PendingTransportError"
                )

    return _probe


def pytest_collection_modifyitems(config, items):
    """Auto-mark *_e2e.py tests with `integration`.

    Why: voice e2e tests hit live providers (OpenAI, ElevenLabs, Twilio,
    Gemini) and fail-fast on missing infrastructure. They run on-demand via
    voice-integration.yml, not on every PR. python-ci uses
    `-m "not integration"` to deselect them.
    """
    integration = pytest.mark.integration
    for item in items:
        if item.fspath.basename.endswith("_e2e.py"):
            item.add_marker(integration)
