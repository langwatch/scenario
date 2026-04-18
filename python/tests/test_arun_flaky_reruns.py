"""`pytest.mark.flaky` + `arun` interplay.

The scenario examples lean heavily on `@pytest.mark.flaky(reruns=2)`
to absorb LLM noise. When a rerun kicks in, the previous attempt's
state (event bus worker thread, tracing contextvars, LangWatchTrace
context tokens) must not carry over into the retry.

This test fails on the first two attempts and passes on the third —
if reruns are broken (e.g. a dangling contextvar / worker thread
from attempt 1 poisons attempt 3) the assertion in the final attempt
will surface it.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


_attempt_counter = {"n": 0}


class _RetryableAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        _attempt_counter["n"] += 1
        # Fail the first two attempts, pass on the third.
        if _attempt_counter["n"] < 3:
            raise AssertionError(
                f"intentional flake #{_attempt_counter['n']}"
            )
        return {"role": "assistant", "content": "ok"}


class _User(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hi"


class _Judge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["t"]
        )


@pytest.mark.flaky(reruns=3)
@pytest.mark.asyncio
async def test_arun_survives_pytest_reruns():
    """Two flakes followed by a success — exercise pytest-rerunfailures."""
    result = await scenario.arun(
        name="flaky-arun",
        description="flaky test with reruns",
        agents=[_RetryableAgent(), _User(), _Judge()],
        script=[
            scenario.user("hi"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success is True
    # The third attempt is the one that succeeded; prior attempts
    # incremented the counter then raised before the judge ran.
    assert _attempt_counter["n"] == 3, (
        f"expected 3 attempts to reach the third try, got {_attempt_counter['n']}"
    )


@pytest.mark.asyncio
async def test_event_loop_stays_stable_across_reruns():
    """Even after a forced failure, a follow-up arun on the same loop
    still works — guards against a half-torn-down event bus leaving a
    lingering reference that fights the next run.
    """

    class _Boom(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            raise RuntimeError("boom")

    # First call raises; event_bus must still drain cleanly so the
    # second call is unaffected.
    with pytest.raises(Exception):
        await scenario.arun(
            name="boom-1",
            description="first raises",
            agents=[_Boom(), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    # Second call on the same loop should complete normally.
    class _Good(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            return {"role": "assistant", "content": "ok"}

    result = await scenario.arun(
        name="boom-2",
        description="second succeeds",
        agents=[_Good(), _User(), _Judge()],
        script=[
            scenario.user("hi"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
