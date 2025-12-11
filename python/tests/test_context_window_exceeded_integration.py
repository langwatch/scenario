"""
Integration tests for context window exceeded error handling.

Tests that when an agent exceeds the LLM context window:
1. The error identifies which agent caused the failure
2. Reports are still sent even when errors occur

See: specs/context-window-exceeded.feature
"""

import pytest
from typing import List

import scenario
from scenario._generated.langwatch_api_client.lang_watch_api_client.types import Unset
from scenario.scenario_executor import ScenarioExecutor
from scenario._events import (
    ScenarioEvent,
    ScenarioRunFinishedEvent,
    ScenarioEventBus,
    EventReporter,
)


class VerboseAgent(scenario.AgentAdapter):
    """Agent that returns a response large enough to exceed context limits."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        giant_response = "Here's some weather data:\n" + ("x" * 200_000)
        return {"role": "assistant", "content": giant_response}


class MockUserSimulatorAgent(scenario.AgentAdapter):
    """Mock UserSimulatorAgent that returns a simple message without API calls."""

    role = scenario.AgentRole.USER

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        return {"role": "user", "content": "What's the weather like today?"}


class MockJudgeAgent(scenario.AgentAdapter):
    """Mock JudgeAgent that raises a context window exceeded error."""

    role = scenario.AgentRole.JUDGE

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        raise Exception(
            "This model's maximum context length is 16385 tokens. "
            "However, your messages resulted in 50000 tokens."
        )


class MockEventReporter(EventReporter):
    """Captures events without HTTP calls."""

    def __init__(self) -> None:
        self.posted_events: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent) -> dict:
        self.posted_events.append(event)
        return {}


@pytest.mark.asyncio
async def test_error_identifies_agent_that_exceeded_context():
    """
    Scenario: Error identifies the agent that exceeded context

    Given a VerboseAgent that returns 200k characters
    And a JudgeAgent with a 16k context model
    When the scenario runs
    Then it should raise a context window error
    And the error message should contain "JudgeAgent"
    And the error message should mention "token" or "context"
    """
    with pytest.raises(Exception) as exc_info:
        await scenario.run(
            name="context overflow test",
            description="User asks for weather info",
            agents=[
                VerboseAgent(),
                MockUserSimulatorAgent(),
                MockJudgeAgent(),
            ],
            script=[
                scenario.user(),
                scenario.agent(),
                scenario.proceed(),
            ],
        )

    error_msg = str(exc_info.value)
    assert (
        "MockJudgeAgent" in error_msg
    ), f"Error should identify MockJudgeAgent, got: {error_msg}"
    assert (
        "token" in error_msg.lower() or "context" in error_msg.lower()
    ), f"Error should mention tokens or context, got: {error_msg}"


@pytest.mark.asyncio
async def test_reports_sent_when_context_exceeded():
    """
    Scenario: Reports are still sent when context is exceeded

    Given a VerboseAgent that returns 200k characters
    And a JudgeAgent with a 16k context model
    When the scenario runs and fails
    Then a ScenarioRunFinishedEvent should be emitted
    And the event status should be "ERROR"
    And the event reasoning should contain the error message
    """
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)
    events: List[ScenarioEvent] = []

    executor = ScenarioExecutor(
        name="context overflow test",
        description="User asks for weather info",
        agents=[
            VerboseAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(),
        ],
        script=[
            scenario.user(),
            scenario.agent(),
            scenario.proceed(),
        ],
        event_bus=event_bus,
    )
    executor.events.subscribe(events.append)

    with pytest.raises(Exception):
        await executor.run()

    finish_events = [e for e in events if isinstance(e, ScenarioRunFinishedEvent)]
    assert len(finish_events) == 1, "Should emit finish event even on error"

    finish_event = finish_events[0]
    assert finish_event.status.value == "ERROR"
    results = finish_event.results
    assert not isinstance(results, Unset) and results is not None
    reasoning = results.reasoning
    assert isinstance(reasoning, str)
    assert "MockJudgeAgent" in reasoning
