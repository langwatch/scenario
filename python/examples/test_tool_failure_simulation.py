"""
Example test demonstrating tool failure simulation.

This example shows how to test agent resilience by simulating tool failures,
timeouts, and other error conditions.
"""

import pytest
import scenario
from unittest.mock import patch


def call_external_service(endpoint: str) -> str:
    """Call an external service."""
    # This would normally make an external API call
    raise NotImplementedError("This should be mocked in tests")


class ResilientAgent(scenario.AgentAdapter):
    """Agent that handles external service failures gracefully."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        user_message = input.last_new_user_message_str()

        if "call" in user_message.lower() and "service" in user_message.lower():
            try:
                result = call_external_service("/api/data")
                return f"Service call result: {result}"
            except Exception as e:
                return f"I encountered an error calling the service: {str(e)}. Let me try a different approach."

        return "I can help you call external services."


def check_error_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains error information."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        assert "error" in content.lower()


def check_rate_limit_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains rate limit error."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        assert "Rate limit exceeded" in content


def check_success_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains success information."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        assert "Service call successful" in content


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_tool_timeout_simulation():
    """Test agent's ability to handle tool timeouts."""

    with patch("test_tool_failure_simulation.call_external_service") as mock_service:
        # Simulate timeout error
        mock_service.side_effect = Exception("Request timeout")

        result = await scenario.run(
            name="tool timeout test",
            description="Test agent's ability to handle tool timeouts",
            agents=[
                ResilientAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Call the external service"),
                scenario.agent(),
                lambda state: mock_service.assert_called_once_with("/api/data"),
                check_error_in_message,
                scenario.succeed(),
            ],
        )

        assert result.success


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_tool_rate_limit_simulation():
    """Test agent's ability to handle rate limits."""

    with patch("test_tool_failure_simulation.call_external_service") as mock_service:
        # Simulate rate limit error
        mock_service.side_effect = Exception("Rate limit exceeded")

        result = await scenario.run(
            name="tool rate limit test",
            description="Test agent's ability to handle rate limits",
            agents=[
                ResilientAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Call the external service"),
                scenario.agent(),
                lambda state: mock_service.assert_called_once_with("/api/data"),
                check_rate_limit_in_message,
                scenario.succeed(),
            ],
        )

        assert result.success


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_tool_success_simulation():
    """Test agent's ability to handle successful tool calls."""

    with patch("test_tool_failure_simulation.call_external_service") as mock_service:
        # Simulate successful service call
        mock_service.return_value = "Service call successful"

        result = await scenario.run(
            name="tool success test",
            description="Test agent's ability to handle successful tool calls",
            agents=[
                ResilientAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Call the external service"),
                scenario.agent(),
                lambda state: mock_service.assert_called_once_with("/api/data"),
                check_success_in_message,
                scenario.succeed(),
            ],
        )

        assert result.success
