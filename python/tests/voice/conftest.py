"""
Shared test configuration and skip-guard fixtures for the voice suite.

Philosophy: each @e2e test skips only when the *specific infrastructure
it needs* is absent — not when a generic API key happens to be missing.
Detection methods:

- **Port probe** — for locally-run bots (Pipecat on :8765). A quick TCP
  connect check answers "is the dev dependency actually up?" without
  hitting real APIs.
- **Env var** — for cloud creds that double as "is this feature enabled
  in my account?" (ELEVENLABS_AGENT_ID, TWILIO_PHONE_NUMBER, etc.).
- **Capability probe** — for adapters that still raise
  PendingTransportError. Instantiate, try a connect(), skip if it
  raises the sentinel. Avoids hardcoding "is this shipped yet" into
  env-var feature flags that go stale.
- **LLM smoke probe** — for keys that exist but may be scope-restricted
  (e.g., test keys without model.request scope). One tiny completion
  call answers "can the judge actually run?" before a 30-second test
  wastes time failing in that.

If a fixture decides to skip, it raises pytest.skip with a message
explaining *which specific dependency is absent*, so CI logs show real
coverage instead of opaque skips.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

import pytest

# Load .env before any fixture or test runs.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass

import scenario

# Configure a sensible default so tests that don't specify a model
# don't fail with "UserSimulatorAgent was initialized without a model".
if os.getenv("OPENAI_API_KEY"):
    scenario.configure(default_model="openai/gpt-4.1-mini")


# --------------------------------------------------------------------- #
# Skip guards                                                           #
# --------------------------------------------------------------------- #


def _tcp_port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    """Quick TCP probe — True if something is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


_llm_probe_cache: dict[str, bool] = {}


def _llm_callable(model: str = "openai/gpt-4.1-mini") -> bool:
    """
    One-shot litellm probe: can we actually run a completion?

    Cached per-model so the probe runs at most once per session. Catches
    the "key exists but lacks model.request scope" failure mode that's
    common with restricted test keys.
    """
    if model in _llm_probe_cache:
        return _llm_probe_cache[model]
    if not os.getenv("OPENAI_API_KEY"):
        _llm_probe_cache[model] = False
        return False
    try:
        import litellm

        litellm.completion(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=1,
        )
        _llm_probe_cache[model] = True
    except Exception:
        _llm_probe_cache[model] = False
    return _llm_probe_cache[model]


@pytest.fixture
def requires_llm():
    """Skip unless the default judge/simulator LLM is actually callable."""
    if not _llm_callable():
        pytest.skip("default LLM not callable (missing/restricted OPENAI_API_KEY)")


@pytest.fixture
def requires_pipecat_bot():
    """Skip unless a Pipecat bot is listening on localhost:8765."""
    if not _tcp_port_open("localhost", 8765):
        pytest.skip("Pipecat bot not running on localhost:8765")


@pytest.fixture
def requires_elevenlabs_hosted_agent():
    """Skip unless an ElevenLabs hosted agent_id + api_key are configured."""
    if not (os.getenv("ELEVENLABS_API_KEY") and os.getenv("ELEVENLABS_AGENT_ID")):
        pytest.skip("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID required")


@pytest.fixture
def requires_elevenlabs_key():
    """Skip unless ELEVENLABS_API_KEY is set (STT + branded demos)."""
    if not os.getenv("ELEVENLABS_API_KEY"):
        pytest.skip("ELEVENLABS_API_KEY required")


@pytest.fixture
def requires_gemini_key():
    """Skip unless GEMINI_API_KEY is set."""
    if not os.getenv("GEMINI_API_KEY"):
        pytest.skip("GEMINI_API_KEY required")


@pytest.fixture
def requires_twilio_outbound():
    """Skip unless Twilio creds + a destination phone are configured."""
    for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_TO_NUMBER"):
        if not os.getenv(k):
            pytest.skip(f"Twilio outbound demo requires {k}")


@pytest.fixture
def requires_twilio_inbound():
    """
    Skip unless Twilio creds + INTEGRATION_MANUAL=1 are set.

    Twilio inbound requires a human to dial the number; we gate it behind
    an explicit manual flag so CI never hangs waiting for a call.
    """
    if not os.getenv("INTEGRATION_MANUAL"):
        pytest.skip("Twilio inbound demo is manual — set INTEGRATION_MANUAL=1 to run")
    for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"):
        if not os.getenv(k):
            pytest.skip(f"Twilio inbound demo requires {k}")


@pytest.fixture
def requires_transport_ready():
    """
    Factory for capability probes: skip if adapter.connect() still raises
    PendingTransportError.

    Usage:
        def test_x(requires_transport_ready):
            adapter = OpenAIRealtimeAgentAdapter(...)
            requires_transport_ready(adapter)
            # ...proceed

    Catches the "this transport isn't shipped yet" case without any
    per-adapter env-var feature flag. When the transport ships, the probe
    stops raising, and the test runs.
    """
    import asyncio

    from scenario.voice.adapters._stub import PendingTransportError

    def _probe(adapter):
        async def _try():
            try:
                await adapter.connect()
                await adapter.disconnect()
            except PendingTransportError as e:
                pytest.skip(f"transport not yet shipped: {e}")
            except Exception:
                # Real errors (auth, network) should NOT be swallowed —
                # let the test see them.
                pass

        try:
            asyncio.get_event_loop().run_until_complete(_try())
        except RuntimeError:
            asyncio.run(_try())

    return _probe
