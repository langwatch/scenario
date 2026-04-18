"""``scenario.arun`` must drain the event bus in its ``finally`` block,
even when the adapter raises.

A scenario that emits a ``SCENARIO_RUN_STARTED`` event then has its
agent raise must: (a) re-raise, (b) send all pending events to the
reporter before returning.

We stub out the event reporter so we can count calls regardless of
whether the local endpoint is reachable.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List
from unittest.mock import patch

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario._events import ScenarioEvent
from scenario._events.event_reporter import EventReporter
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _CountingReporter(EventReporter):
    """Drop-in reporter that records every event instead of POSTing."""

    def __init__(self) -> None:
        super().__init__(endpoint="http://localhost", api_key="test")
        self.received: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        self.received.append(event)
        return {}


class _Boom(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        raise RuntimeError("intentional failure")


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
async def test_event_bus_drains_on_adapter_exception():
    reporter = _CountingReporter()

    def _reporter_factory(*args, **kwargs):
        return reporter

    # Patch the default constructor so arun's ScenarioExecutor picks
    # up our fake reporter.
    with patch(
        "scenario._events.event_bus.EventReporter",
        side_effect=_reporter_factory,
    ):
        with pytest.raises(Exception):
            await scenario.arun(
                name="drain-on-error",
                description="verifies drain-on-finally",
                agents=[_Boom(), _User(), _Judge()],
                script=[
                    scenario.user("hi"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

    # The SCENARIO_RUN_STARTED event fires before the adapter runs; the
    # SCENARIO_RUN_FINISHED event fires in the scenario's error branch.
    types = [e.type_ for e in reporter.received]
    assert "SCENARIO_RUN_STARTED" in types, (
        f"Expected RUN_STARTED to reach reporter, got: {types}"
    )
    assert "SCENARIO_RUN_FINISHED" in types, (
        f"Expected RUN_FINISHED to reach reporter (arun's finally drain "
        f"should flush even on exception), got: {types}"
    )
