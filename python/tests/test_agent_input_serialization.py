"""
Regression: pydantic serializer warnings emitted by an agent's litellm call
must NOT leak out of ``ScenarioExecutor._call_agent``.

Real bug observed during ``Judging...``:

    /pydantic/functional_validators.py:835: UserWarning: Pydantic serializer warnings:
      PydanticSerializationUnexpectedValue(Expected `literal['developer']` ... [field_name='role', input_value='system', ...])
      PydanticSerializationUnexpectedValue(Expected 3 fields but got 2 ...)
      ... (~12 lines per turn)

The executor *already* wraps the agent invocation in
``with warnings.catch_warnings(); warnings.simplefilter('ignore')`` — but it
only wraps the *creation* of the coroutine, not the ``await`` of it.
litellm.completion (where the warnings actually fire) runs during the await,
so the suppression was bypassed.

This test feeds a fake agent that emits a pydantic-shaped warning *during*
its awaited body, then asserts the warning never escapes the executor.
"""

from __future__ import annotations

import warnings
from typing import List, cast

import pytest

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import (
    AgentInput,
    AgentReturnTypes,
    AgentRole,
    ScenarioResult,
)


PYDANTIC_WARNING_TEXT = (
    "Pydantic serializer warnings: "
    "PydanticSerializationUnexpectedValue(Expected `literal['developer']` "
    "- serialized value may not be as expected [field_name='role', "
    "input_value='system', input_type=str])"
)


class _WarningEmittingAgent(AgentAdapter):
    """Stub agent that emits the exact warning shape pydantic uses during
    litellm's union-dispatch over ChatCompletionMessageParam variants. The
    warning is raised *during* the await (after a checkpoint) — that's the
    spot where the executor's suppression context used to be closed."""

    role = AgentRole.AGENT

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        import asyncio

        # Hop the event loop once so we're definitely past coroutine
        # construction by the time we emit. This mirrors litellm.completion
        # which awaits httpx underneath.
        await asyncio.sleep(0)
        warnings.warn(PYDANTIC_WARNING_TEXT, UserWarning, stacklevel=2)
        return "ok"


class _StubJudge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(success=True, messages=[], reasoning="done")


class _StubUser(AgentAdapter):
    """No-op user. The scripted ``scenario.user('hi')`` provides the message
    content; the agent slot just needs to exist for the executor to route to."""

    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hi"


@pytest.mark.asyncio
async def test_pydantic_warnings_during_agent_await_are_suppressed():
    """Run a 1-turn scenario whose agent emits a pydantic-style serializer
    warning *during* its await. The executor must swallow it; the test fails
    if the warning escapes to the caller."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await scenario.run(
            name="warning_suppression_regression",
            description="agent emits a pydantic warning during its await",
            agents=[
                _WarningEmittingAgent(),
                _StubUser(),
                _StubJudge(),
            ],
            script=[scenario.user("hi"), scenario.agent(), scenario.judge()],
            max_turns=1,
            set_id="regression",
        )

    pydantic_warnings = [
        w for w in caught if "Pydantic serializer warnings" in str(w.message)
    ]
    assert not pydantic_warnings, (
        f"Pydantic serializer warning leaked out of ScenarioExecutor._call_agent. "
        f"Got {len(pydantic_warnings)}: {[str(w.message) for w in pydantic_warnings]}"
    )
