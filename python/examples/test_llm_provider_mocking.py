"""
Example test demonstrating LLM provider mocking.

This example shows how to mock LLM provider APIs for testing agent flow
without actual LLM calls. However, Scenario's caching system is often
a better solution for deterministic, cost-effective testing.
"""

import pytest
import scenario
from unittest.mock import patch


class ChatAgent(scenario.AgentAdapter):
    """Simple chat agent that directly returns responses (simulating LLM behavior)."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        user_message = input.last_new_user_message_str()

        # Simple agent logic without actual LLM calls
        if "hello" in user_message.lower():
            return "I can help you with that request."

        return "I'm here to help!"


def check_agent_response(state: scenario.ScenarioState) -> None:
    """Check that the agent responded with expected content."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        assert content == "I can help you with that request."


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_llm_provider_mocking():
    """Test agent behavior without actual LLM calls."""

    # This example shows testing agent logic without LLM provider mocking
    # In practice, Scenario's caching system is often better than mocking LLMs

    result = await scenario.run(
        name="llm mock test",
        description="Test agent behavior with deterministic responses",
        agents=[
            ChatAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
        ],
        script=[
            scenario.user("Hello"),
            scenario.agent(),
            check_agent_response,
            scenario.succeed(),
        ],
    )

    assert result.success
