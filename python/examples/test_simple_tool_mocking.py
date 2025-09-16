"""
Example test demonstrating simple tool function mocking.

This example shows how to mock tool functions to test agent behavior
without external dependencies.
"""

import pytest
import scenario
from unittest.mock import patch


def fetch_user_data(user_id: str) -> dict:
    """Fetch user data from external API."""
    # This would normally make an API call
    raise NotImplementedError("This should be mocked in tests")


class UserDataAgent(scenario.AgentAdapter):
    """Simple agent that fetches user data using a tool."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        user_message = input.last_new_user_message_str()

        # Simple agent logic - if user asks for user data with ID, call the tool
        if "user data" in user_message.lower() and "123" in user_message:
            try:
                result = fetch_user_data("123")
                return f"User data: {result['name']} has {result['points']} points."
            except Exception as e:
                return f"Error fetching user data: {str(e)}"

        return "I can help you fetch user data. Please provide a user ID."


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_simple_tool_mocking():
    """Test mocking a tool function to control agent behavior."""

    with patch("test_simple_tool_mocking.fetch_user_data") as mock_fetch:
        # Setup mock return value
        mock_fetch.return_value = {
            "name": "Alice",
            "points": 150,
            "email": "alice@example.com",
        }

        result = await scenario.run(
            name="user data tool test",
            description="Test agent's ability to fetch user data via mocked tool",
            agents=[
                UserDataAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Show me user data for ID 123"),
                scenario.agent(),
                lambda state: mock_fetch.assert_called_once_with("123"),
                scenario.succeed(),
            ],
        )

        assert result.success
