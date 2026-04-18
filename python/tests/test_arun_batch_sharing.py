"""Concurrent ``scenario.arun`` invocations must share one
``batch_run_id`` so the LangWatch UI groups them under a single batch.

The batch id is stored in a module-level environment variable
(``SCENARIO_BATCH_RUN_ID``) and set on first read. Pure asyncio has
no preemption between the env-var get and set, so every arun call
inside a single event loop sees the same id.
"""

from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _Agent(AgentAdapter):
    def __init__(self, captured: list[str]):
        self._captured = captured

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        self._captured.append(input.scenario_state._executor.batch_run_id)
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


@pytest.mark.asyncio
async def test_concurrent_arun_shares_one_batch_run_id():
    captured: list[str] = []

    async def one(i: int):
        return await scenario.arun(
            name=f"batch-{i}",
            description="batch sharing",
            agents=[_Agent(captured), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    results = await asyncio.gather(*(one(i) for i in range(5)))
    assert all(r.success for r in results)

    assert len(set(captured)) == 1, (
        f"Concurrent arun calls should share one batch_run_id, got "
        f"{set(captured)}"
    )
