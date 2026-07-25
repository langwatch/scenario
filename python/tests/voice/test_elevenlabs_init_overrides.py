"""
Issue #838 — ``dynamic_variables`` + ``overrides`` on the init handshake.

Python parity with the TS adapter's ``dynamicVariables`` / ``overrides`` options.

Production integrations personalise a hosted agent per call by sending
``dynamic_variables`` (which fill the DEPLOYED prompt template) plus a narrow
``agent.{language, first_message}`` override. They do NOT override the system
prompt: on ElevenLabs that replaces the entire prompt object including
``tool_ids``, so an agent relying on server tools silently loses them and then
stalls waiting for tool responses that can never arrive.

These tests drive the adapter through an injected fake WebSocket and prove the
init frame the adapter puts on the wire:
 1. ``dynamic_variables`` are forwarded natively, keeping their JSON types;
 2. the key is OMITTED entirely when unset (EL distinguishes absent from ``{}``);
 3. caller ``overrides`` deep-merge UNDER the narrow prompt/first-message knobs,
    so ``agent.language`` and ``agent.prompt`` both survive;
 4. the narrow knobs win on a shared leaf.

The LIVE proof (real EL agent answering in Spanish from an injected plan tier)
is in the PR description.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from scenario.voice import ElevenLabsAgentAdapter


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True


async def _init_frame(**kwargs: Any) -> dict[str, Any]:
    """Connect an adapter over a fake socket and return the init frame it sent."""
    socket = FakeSocket()
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test", **kwargs)
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    await adapter.stop_pump()
    init = json.loads(socket.sent[0])
    assert init["type"] == "conversation_initiation_client_data"
    return init


# --------------------------------------------------------------------------- #
# dynamic_variables                                                            #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_dynamic_variables_are_forwarded_with_native_json_types():
    """Text / numeric / boolean pass through uncoerced — EL supports all three."""
    init = await _init_frame(
        dynamic_variables={"tenant_id": "acme", "seat_tier": 2, "is_vip": True}
    )

    assert init["dynamic_variables"] == {
        "tenant_id": "acme",
        "seat_tier": 2,
        "is_vip": True,
    }
    # Not stringified — a str() coercion would break EL's typed variables.
    assert isinstance(init["dynamic_variables"]["seat_tier"], int)
    assert isinstance(init["dynamic_variables"]["is_vip"], bool)


@pytest.mark.asyncio
async def test_dynamic_variables_key_is_absent_when_unset():
    """Unset means NO key, not an empty object."""
    init = await _init_frame()

    assert "dynamic_variables" not in init


@pytest.mark.asyncio
async def test_empty_dynamic_variables_dict_is_still_sent():
    """An explicitly-passed empty dict is the caller's choice — send it."""
    init = await _init_frame(dynamic_variables={})

    assert init["dynamic_variables"] == {}


# --------------------------------------------------------------------------- #
# overrides deep-merge                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_overrides_deep_merge_keeps_caller_language_and_adapter_prompt():
    """The #838 shape: a caller's agent.language and the adapter's agent.prompt
    must BOTH survive. A shallow spread would drop one side's nested `agent`."""
    init = await _init_frame(
        system_prompt_override="Be terse.",
        first_message_override="Test harness here.",
        overrides={"agent": {"language": "es"}, "tts": {"stability": 0.3}},
    )

    cco = init["conversation_config_override"]
    assert cco["agent"]["language"] == "es"
    assert cco["agent"]["prompt"] == {"prompt": "Be terse."}
    assert cco["agent"]["first_message"] == "Test harness here."
    # A top-level sibling key the narrow knobs never touch survives intact.
    assert cco["tts"] == {"stability": 0.3}


@pytest.mark.asyncio
async def test_narrow_knob_wins_over_overrides_on_a_shared_leaf():
    """On the same leaf the narrow override is the higher-precedence layer."""
    init = await _init_frame(
        system_prompt_override="narrow wins",
        overrides={"agent": {"prompt": {"prompt": "base loses"}}},
    )

    assert init["conversation_config_override"]["agent"]["prompt"] == {
        "prompt": "narrow wins"
    }


@pytest.mark.asyncio
async def test_overrides_alone_do_not_require_the_narrow_knobs():
    """`overrides` is usable on its own — the empty `agent` layer is a no-op."""
    init = await _init_frame(overrides={"agent": {"language": "fr"}})

    assert init["conversation_config_override"]["agent"] == {"language": "fr"}


@pytest.mark.asyncio
async def test_handshake_shape_is_stable_with_no_options():
    """No options still sends a well-formed (empty) override block."""
    init = await _init_frame()

    assert init["conversation_config_override"] == {"agent": {}}
