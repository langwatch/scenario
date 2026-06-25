#!/usr/bin/env python3
"""
Provision (or reuse) an ElevenLabs Conversational AI test agent.

**This script is for Scenario SDK's own CI — NOT for SDK users.** If you
are a developer using Scenario to test your own deployed ElevenLabs agent,
you already have an ``agent_id`` from the ElevenLabs dashboard — set it as
``ELEVENLABS_AGENT_ID`` in your ``.env`` and skip this script entirely.
See https://scenario-docs.langwatch.ai/voice/happy-path-elevenlabs.

This script exists so the SDK's own ``@e2e`` demos have a throwaway agent
to target in CI without manual dashboard clicks.

Usage:
    # From repo root (via Makefile):
    make voice-elevenlabs-provision

    # Or directly from python/:
    cd python && uv run python ../scripts/provision_elevenlabs_agent.py

What it does:
  1. Reads ELEVENLABS_API_KEY from the environment (or python/.env).
  2. Lists existing agents via GET /v1/convai/agents.
  3. If an agent named "scenario-e2e-test-agent" already exists, reuses it.
  4. Otherwise, creates it via POST /v1/convai/agents/create with a minimal config.
  5. Writes ``ELEVENLABS_AGENT_ID=<id>`` to python/.env (append only if not
     already present). Idempotent — safe to re-run.
  6. Prints the agent_id to stdout so callers can capture it.

Exit codes:
    0  — agent_id written and printed.
    1  — ELEVENLABS_API_KEY missing or API call failed.

Self-contained: uses httpx (already a hard dep of scenario). Does NOT import
the elevenlabs Python SDK.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Load python/.env so the script works from any CWD.
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve()
_PYTHON_DIR = _HERE.parent.parent / "python"
_ENV_FILE = _PYTHON_DIR / ".env"

try:
    from dotenv import load_dotenv

    load_dotenv(_ENV_FILE)
except ImportError:
    pass  # dotenv is optional; env vars may already be set in the shell

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Sentinel name. Override via ELEVENLABS_AGENT_NAME env var (e.g. "Test Agent")
# if your account already has an agent under a different name.
AGENT_NAME = os.environ.get("ELEVENLABS_AGENT_NAME", "scenario-e2e-test-agent")
# Concise voice-agent system prompt. Real-time voice demos cannot tolerate
# minute-long replies — keep answers tight by default.
#
# The interruption demo needs the agent to keep talking long enough for a
# barge-in to overlap, so it injects an inline override via the
# conversation_initiation_client_data message (or a separate verbose agent),
# rather than baking verbosity into the shared test agent.
SYSTEM_PROMPT = (
    "You are a concise customer-service voice assistant at TestCo. "
    "Answer in 1-2 short sentences. This is real-time voice — long "
    "monologues are wrong. Be warm, clear, and direct. If asked for "
    "details, give one example and stop. Wait for the caller's next turn."
)
ELEVENLABS_API_BASE = "https://api.elevenlabs.io"


def _turn_config() -> dict:
    """Agent-level turn-taking config for the issue-#705 real-voice multi-turn
    (``turnCommitMode="audio"``) path.

    Why on the AGENT and not per-session: EL does NOT expose ``turn_timeout`` /
    ``turn_eagerness`` as ``conversation_config_override.turn`` fields (the
    per-session override only carries ``soft_timeout_config`` — verified against
    ``@elevenlabs/elevenlabs-js`` ``TurnConfigOverride``). So aggressive
    turn-taking for a scripted, non-mic stream has to be provisioned here.

    The levers (all env-overridable so CI can tune without a code change):
      - ``turn_eagerness="eager"`` — close the user's turn sooner once
        end-of-speech is detected, so EL re-engages with an ASR-driven response.
      - ``retranscribe_on_turn_timeout=True`` — the deterministic backstop: if
        VAD never trips on our non-mic stream, EL re-transcribes the accumulated
        audio at turn_timeout and responds to it (instead of a bare "are you
        there?" re-prompt). This is what should make turns 2+ reliable.
      - ``turn_timeout`` — the silence window; must stay above our inter-turn
        harness latency (TTS gen + send) or the agent re-engages between turns.

    This is a NO-OP for the default ``turnCommitMode="text"`` demos: a text
    commit closes the turn via the ``user_message`` event, never via VAD /
    turn_timeout, so they ignore this block entirely.
    """
    # Only fields verified present on EL's BaseTurnConfig (via
    # @elevenlabs/elevenlabs-js@2.51.0) — sending an unknown key risks a 422 that
    # would fail the whole (load-bearing) provisioning call.
    return {
        "turn_timeout": float(os.environ.get("ELEVENLABS_TURN_TIMEOUT", "7")),
        "turn_eagerness": os.environ.get("ELEVENLABS_TURN_EAGERNESS", "eager"),
        "retranscribe_on_turn_timeout": os.environ.get(
            "ELEVENLABS_RETRANSCRIBE", "true"
        ).lower()
        in ("1", "true", "yes"),
    }


def _api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        print("error: ELEVENLABS_API_KEY is not set", file=sys.stderr)
        sys.exit(1)
    return key


def _list_agents(api_key: str) -> list[dict]:
    """GET /v1/convai/agents — return list of agent dicts."""
    import httpx

    resp = httpx.get(
        f"{ELEVENLABS_API_BASE}/v1/convai/agents",
        headers={"xi-api-key": api_key},
        timeout=30,
    )
    if resp.status_code != 200:
        print(
            f"error: GET /v1/convai/agents returned {resp.status_code}: {resp.text}",
            file=sys.stderr,
        )
        sys.exit(1)
    data = resp.json()
    # The ElevenLabs response wraps agents in {"agents": [...]}
    return data.get("agents") or []


def _create_agent(api_key: str) -> str:
    """POST /v1/convai/agents/create — create agent and return agent_id."""
    import httpx

    payload = {
        "name": AGENT_NAME,
        "conversation_config": {
            "agent": {
                "prompt": {
                    "prompt": SYSTEM_PROMPT,
                },
                "first_message": "Hello! How can I help you today?",
                "language": "en",
            },
            # Match the framework's canonical 24kHz PCM16 so we don't
            # need a per-edge resample at the adapter boundary.
            "asr": {"user_input_audio_format": "pcm_24000"},
            "tts": {"agent_output_audio_format": "pcm_24000"},
            # Aggressive turn-taking for the #705 real-voice multi-turn
            # ("audio") path. No-op for the default text-commit demos.
            "turn": _turn_config(),
        },
        # Allow demo-specific overrides via conversation_initiation_client_data.
        # By default EL rejects ``conversation_config_override.agent.prompt``
        # with a 1008 policy violation; the interruption demo needs to inject
        # a verbose persona just for its session, so we opt this agent in to
        # those overrides at provision time.
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {
                        "first_message": True,
                        "prompt": {"prompt": True},
                    }
                }
            }
        },
    }
    resp = httpx.post(
        f"{ELEVENLABS_API_BASE}/v1/convai/agents/create",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        print(
            f"error: POST /v1/convai/agents/create returned {resp.status_code}: {resp.text}",
            file=sys.stderr,
        )
        sys.exit(1)
    return resp.json()["agent_id"]


def _patch_agent_prompt(api_key: str, agent_id: str) -> None:
    """PATCH /v1/convai/agents/{id} — refresh the agent's prompt to
    ``SYSTEM_PROMPT``. Idempotent. Used so re-runs of provisioning bring
    older test agents in line with the verbose-prompt behaviour the
    interrupt demos depend on.
    """
    import httpx

    payload = {
        "conversation_config": {
            "agent": {
                "prompt": {"prompt": SYSTEM_PROMPT},
                "first_message": "Hello! How can I help you today?",
            },
            "asr": {"user_input_audio_format": "pcm_24000"},
            "tts": {"agent_output_audio_format": "pcm_24000"},
            # Keep reused agents in line with the #705 turn-taking config.
            "turn": _turn_config(),
        },
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {
                        "first_message": True,
                        "prompt": {"prompt": True},
                    }
                }
            }
        },
    }
    resp = httpx.patch(
        f"{ELEVENLABS_API_BASE}/v1/convai/agents/{agent_id}",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        # Soft warning — the agent still works for happy-path demos
        # even if the prompt didn't update.
        print(
            f"warn: PATCH /v1/convai/agents/{agent_id} returned {resp.status_code}: {resp.text}",
            file=sys.stderr,
        )
        return
    print(f"info: refreshed prompt on agent {agent_id}", file=sys.stderr)


def _write_env(agent_id: str) -> None:
    """
    Append ELEVENLABS_AGENT_ID=<id> to python/.env if not already present.

    Creates python/.env if it does not exist.
    """
    key_line = f"ELEVENLABS_AGENT_ID={agent_id}"

    if _ENV_FILE.exists():
        content = _ENV_FILE.read_text()
        # Check if any line already sets ELEVENLABS_AGENT_ID.
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("ELEVENLABS_AGENT_ID="):
                existing_id = stripped.split("=", 1)[1].strip()
                if existing_id == agent_id:
                    # Already present with the same value — nothing to do.
                    return
                # Present but with a different value — update it.
                lines = content.splitlines(keepends=True)
                new_lines = []
                for l in lines:
                    if l.strip().startswith("ELEVENLABS_AGENT_ID="):
                        new_lines.append(f"{key_line}\n")
                    else:
                        new_lines.append(l)
                _ENV_FILE.write_text("".join(new_lines))
                print(f"info: updated ELEVENLABS_AGENT_ID in {_ENV_FILE}", file=sys.stderr)
                return
        # Key not found — append.
        with _ENV_FILE.open("a") as fh:
            if not content.endswith("\n"):
                fh.write("\n")
            fh.write(f"{key_line}\n")
    else:
        _ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ENV_FILE.write_text(f"{key_line}\n")

    print(f"info: wrote ELEVENLABS_AGENT_ID to {_ENV_FILE}", file=sys.stderr)


def main() -> None:
    api_key = _api_key()

    print("info: listing existing ElevenLabs agents...", file=sys.stderr)
    agents = _list_agents(api_key)

    existing = next((a for a in agents if a.get("name") == AGENT_NAME), None)

    if existing:
        agent_id = existing["agent_id"]
        print(f"info: reusing existing agent '{AGENT_NAME}' (id={agent_id})", file=sys.stderr)
        # Refresh the prompt: older test agents may have been created
        # with the previous (terse) SYSTEM_PROMPT.
        _patch_agent_prompt(api_key, agent_id)
    else:
        print(f"info: creating new agent '{AGENT_NAME}'...", file=sys.stderr)
        agent_id = _create_agent(api_key)
        print(f"info: created agent (id={agent_id})", file=sys.stderr)

    _write_env(agent_id)
    # Print agent_id to stdout — callers (Makefile, CI) can capture it.
    print(agent_id)


if __name__ == "__main__":
    main()
