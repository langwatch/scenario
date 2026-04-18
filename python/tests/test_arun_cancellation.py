"""Cancellation semantics for ``scenario.arun``.

Async frameworks expect that task cancellation propagates cleanly.
``arun`` runs the scenario on the caller's loop, so ``task.cancel()``
delivers a CancelledError straight into the scenario's own ``await``
chain — different from the threaded ``scenario.run`` path where
cancellation is effectively unreachable once we handed control to a
worker thread.
"""

from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _SlowAgent(AgentAdapter):
    """Sleeps long enough that outer cancellation lands mid-call."""

    def __init__(self, started: asyncio.Event):
        self._started = started

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        self._started.set()
        await asyncio.sleep(10)
        return {"role": "assistant", "content": "never"}


class _FastAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "fast"}


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


@pytest.mark.asyncio
async def test_cancellation_propagates_into_arun():
    started = asyncio.Event()
    task = asyncio.create_task(
        scenario.arun(
            name="cancelled-scenario",
            description="outer cancels mid-call",
            agents=[_SlowAgent(started), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )
    )

    await asyncio.wait_for(started.wait(), timeout=3.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        _ = await task


@pytest.mark.asyncio
async def test_cancellation_does_not_affect_sibling_arun():
    started = asyncio.Event()

    async def slow():
        return await scenario.arun(
            name="slow-sibling",
            description="will be cancelled",
            agents=[_SlowAgent(started), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    async def fast():
        return await scenario.arun(
            name="fast-sibling",
            description="should complete",
            agents=[_FastAgent(), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    slow_task = asyncio.create_task(slow())
    fast_task = asyncio.create_task(fast())

    # Wait until the slow scenario's agent is in-flight, then cancel it.
    await asyncio.wait_for(started.wait(), timeout=3.0)
    slow_task.cancel()

    # Fast sibling must still complete successfully.
    fast_result = await asyncio.wait_for(fast_task, timeout=5.0)
    assert fast_result.success is True

    with pytest.raises(asyncio.CancelledError):
        _ = await slow_task
