"""
Example test demonstrating a custom judge that accesses OpenTelemetry traces.

This example shows how to build a judge that inspects the agent's OTel spans
to verify specific tool calls were made. The judge uses `grep_trace` to search
through collected spans for evidence of tool usage, giving you visibility into
the agent's internal behavior beyond just its text responses.
"""

import pytest
import scenario
from scenario.types import AgentInput, AgentReturnTypes, ScenarioResult
from scenario._tracing import judge_span_collector
from scenario._judge.trace_tools import grep_trace

scenario.configure(default_model="openai/gpt-4.1-mini")


class ToolVerifyingJudge(scenario.AgentAdapter):
    """A custom judge that checks if the agent called a specific tool by
    inspecting OpenTelemetry traces collected during the scenario run."""

    role = scenario.AgentRole.JUDGE

    def __init__(self, required_tool: str):
        self.required_tool = required_tool

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        if not input.judgment_request:
            return []

        # Collect all spans recorded for this scenario thread
        spans = judge_span_collector.get_spans_for_thread(input.thread_id)

        # Search the spans for evidence of the required tool call
        result = grep_trace(spans, self.required_tool)

        if "No matches found" in result:
            return ScenarioResult(
                success=False,
                messages=[],
                reasoning=f"Tool '{self.required_tool}' was not found in the trace. "
                f"Grep result: {result}",
                passed_criteria=[],
                failed_criteria=[f"Agent must call the '{self.required_tool}' tool"],
            )

        return ScenarioResult(
            success=True,
            messages=[],
            reasoning=f"Tool '{self.required_tool}' was found in the trace. "
            f"Grep result: {result}",
            passed_criteria=[f"Agent must call the '{self.required_tool}' tool"],
            failed_criteria=[],
        )


class SimpleAgent(scenario.AgentAdapter):
    """A simple agent that responds with a helpful message.
    It does not emit tool call spans, so the judge will report failure."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "Sure! Let me look that up for you. The weather today is sunny and 72F."


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_custom_judge_with_traces():
    """Custom judge verifies tool usage via OpenTelemetry trace inspection."""
    result = await scenario.run(
        name="trace-aware judge",
        description="User asks for weather and expects the agent to use a weather tool",
        agents=[
            SimpleAgent(),
            scenario.UserSimulatorAgent(),
            ToolVerifyingJudge(required_tool="weather_lookup"),
        ],
        script=[
            scenario.user("What's the weather like today?"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    # The simple agent does not emit tool call spans, so the judge
    # correctly reports that the required tool was not found.
    assert result.success is False
    assert "weather_lookup" in (result.reasoning or "")
