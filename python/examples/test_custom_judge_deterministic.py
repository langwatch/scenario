"""
Example test demonstrating a fully custom deterministic judge.

This example shows how to build a judge that uses programmatic checks instead
of LLM calls. Fast, cheap, and fully deterministic — useful for verifying
tool usage, message structure, or any condition you can check mechanically.
"""

import pytest
import scenario
from scenario.types import AgentInput, AgentReturnTypes, ScenarioResult

# Configure a default model (user simulator needs one even in scripted mode)
scenario.configure(default_model="openai/gpt-4.1-mini")


class ToolCallJudge(scenario.AgentAdapter):
    """Judge that verifies specific tools were called with expected arguments."""

    role = scenario.AgentRole.JUDGE

    def __init__(self, required_tools: list[str]):
        self.required_tools = required_tools
        self.criteria = [f"Agent calls {tool}" for tool in required_tools]

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        if not input.judgment_request:
            return []  # Not asked to judge yet, continue

        # Collect all tool calls from the conversation
        called_tools = set()
        for msg in input.messages:
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    called_tools.add(tc["function"]["name"])

        # Check each required tool
        passed = [t for t in self.required_tools if t in called_tools]
        failed = [t for t in self.required_tools if t not in called_tools]

        return ScenarioResult(
            success=len(failed) == 0,
            messages=[],
            reasoning=f"Called: {passed}. Missing: {failed}."
            if failed
            else f"All required tools called: {passed}",
            passed_criteria=[f"Agent calls {t}" for t in passed],
            failed_criteria=[f"Agent calls {t}" for t in failed],
        )


class FakeWeatherAgent(scenario.AgentAdapter):
    """A mock agent that always calls get_weather."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": '{"city": "Barcelona"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "Sunny, 24C",
            },
            {
                "role": "assistant",
                "content": "It's sunny and 24C in Barcelona!",
            },
        ]


@pytest.mark.asyncio
async def test_deterministic_judge_pass():
    """Deterministic judge passes when the required tool is called."""
    result = await scenario.run(
        name="deterministic judge - tool called",
        description="User asks about the weather",
        agents=[
            FakeWeatherAgent(),
            scenario.UserSimulatorAgent(),
            ToolCallJudge(required_tools=["get_weather"]),
        ],
        script=[
            scenario.user("What's the weather in Barcelona?"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    assert result.success
    assert "Agent calls get_weather" in result.passed_criteria


@pytest.mark.asyncio
async def test_deterministic_judge_fail():
    """Deterministic judge fails when a required tool is missing."""
    result = await scenario.run(
        name="deterministic judge - tool missing",
        description="User asks about the weather",
        agents=[
            FakeWeatherAgent(),
            scenario.UserSimulatorAgent(),
            ToolCallJudge(
                required_tools=["get_weather", "get_forecast"]
            ),
        ],
        script=[
            scenario.user("What's the weather in Barcelona?"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    assert not result.success
    assert "Agent calls get_weather" in result.passed_criteria
    assert "Agent calls get_forecast" in result.failed_criteria
