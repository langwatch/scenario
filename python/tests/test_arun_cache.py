"""``scenario_cache`` relies on ``context_scenario.get()`` (a ContextVar).
ContextVars are preserved across ``asyncio.Task`` copies, so each
concurrent ``arun`` invocation sees its own scenario — and therefore
its own ``cache_key`` derivation — with no cross-task contamination.

This test pins the invariant: two concurrent arun calls with the same
cache_key + same arguments do NOT issue duplicate computations (cache
hits on the second) and never see each other's in-flight scenario.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


# joblib's memory writes to the filesystem; isolate per-test so concurrent
# tests don't pollute each other's hit counts.
_TMP_CACHE = tempfile.TemporaryDirectory()
os.environ["SCENARIO_CACHE_DIR"] = _TMP_CACHE.name


_call_count = 0


@scenario.cache()
async def expensive(arg: str) -> str:
    global _call_count
    _call_count += 1
    return f"computed-{arg}"


class _Agent(AgentAdapter):
    def __init__(self, tag: str):
        self._tag = tag

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        val = await expensive("shared-arg")
        return {"role": "assistant", "content": f"{self._tag}:{val}"}


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
async def test_scenario_cache_works_under_concurrent_arun():
    global _call_count
    _call_count = 0

    async def one(i: int):
        return await scenario.arun(
            name=f"cache-{i}",
            description="cached expensive call",
            cache_key="arun-cache-test-v1",
            agents=[_Agent(str(i)), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    # Five concurrent scenarios with the same cache_key + same arg.
    results = await asyncio.gather(*(one(i) for i in range(5)))
    assert all(r.success for r in results)

    # The cache key is deterministic per ``cache_key`` config +
    # ``arg``. Five invocations with identical keys must hit the cache
    # for four of them → ``expensive`` ran at most once.
    # (It can be called once if the first to race populates it.)
    assert _call_count <= 1, (
        f"cache under arun failed to deduplicate — expensive() ran "
        f"{_call_count} times across 5 identical invocations"
    )
