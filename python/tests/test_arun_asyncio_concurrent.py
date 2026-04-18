"""The customer's intended pattern: ``@pytest.mark.asyncio_concurrent``
group runs multiple async test coroutines on the same loop in parallel.
With ``scenario.arun`` that stays async-native, each test's scenario
must:

- share the single event loop the plugin provides,
- not raise any "Future attached to a different loop" error,
- produce its own result independently.

The two tests below are grouped so the plugin interleaves them. If
``scenario.run`` were used in place of ``arun``, this file would serve
as a negative control — but we only assert the positive case here.
"""

from __future__ import annotations

import asyncio
import os
import threading

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _Agent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
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


@pytest.mark.asyncio_concurrent(group="arun-pytest-concurrent")
async def test_arun_in_concurrent_group_one():
    """Two sibling tests run on the same event loop. Holding a resource
    bound to that loop across them must not raise."""
    loop = asyncio.get_running_loop()
    result = await scenario.arun(
        name="concurrent-one",
        description="pytest-asyncio-concurrent sibling",
        agents=[_Agent(), _User(), _Judge()],
        script=[
            scenario.user("hi"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
    # Adapter ran on the same loop pytest-asyncio-concurrent is using.
    assert asyncio.get_running_loop() is loop
    # And on the main thread — arun never offloads an async adapter.
    assert threading.current_thread() is threading.main_thread()


@pytest.mark.asyncio_concurrent(group="arun-pytest-concurrent")
async def test_arun_in_concurrent_group_two():
    loop = asyncio.get_running_loop()
    result = await scenario.arun(
        name="concurrent-two",
        description="pytest-asyncio-concurrent sibling",
        agents=[_Agent(), _User(), _Judge()],
        script=[
            scenario.user("hi"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success
    assert asyncio.get_running_loop() is loop
    assert threading.current_thread() is threading.main_thread()
