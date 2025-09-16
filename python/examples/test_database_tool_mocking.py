"""
Example test demonstrating database tool mocking.

This example shows how to mock database operations to test agent behavior
without actual database dependencies.
"""

import pytest
import scenario
from unittest.mock import patch


def save_user(name: str, email: str) -> dict:
    """Save a user to the database."""
    # This would normally save to a database
    raise NotImplementedError("This should be mocked in tests")


class DatabaseAgent(scenario.AgentAdapter):
    """Simple agent that saves user data using a database tool."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        user_message = input.last_new_user_message_str()

        # Simple agent logic - extract name and email from user message
        if "save" in user_message.lower() and "user" in user_message.lower():
            # Simple parsing - look for name and email patterns
            if "John" in user_message and "john@example.com" in user_message:
                try:
                    result = save_user("John", "john@example.com")
                    return f"User saved with ID: {result['id']}"
                except Exception as e:
                    return f"Error saving user: {str(e)}"

        return "I can help you save user data. Please provide a name and email."


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_database_tool_mocking():
    """Test mocking a database tool function."""

    with patch("test_database_tool_mocking.save_user") as mock_save:
        # Setup mock return value
        mock_save.return_value = {
            "id": 123,
            "name": "John",
            "email": "john@example.com",
        }

        result = await scenario.run(
            name="database save test",
            description="Test agent's ability to save user data via mocked database tool",
            agents=[
                DatabaseAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Save a new user named John with email john@example.com"),
                scenario.agent(),
                lambda state: mock_save.assert_called_once_with(
                    "John", "john@example.com"
                ),
                scenario.succeed(),
            ],
        )

        assert result.success
