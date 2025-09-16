"""
Example test demonstrating API/service mocking.

This example shows how to mock HTTP calls within tools to test the interface
between your agent system and external dependencies.
"""

import pytest
import scenario
from unittest.mock import patch, AsyncMock
import httpx


async def fetch_user_data(user_id: str) -> dict:
    """Fetch user data from external API."""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"https://api.example.com/users/{user_id}")
        return response.json()


class UserDataAgent(scenario.AgentAdapter):
    """Agent that fetches user data from an external API."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        user_message = input.last_new_user_message_str()

        # Simple agent logic - if user asks for user data with ID, call the API
        if "user data" in user_message.lower() and "123" in user_message:
            try:
                result = await fetch_user_data("123")
                return f"User: {result['name']} ({result['email']})"
            except Exception as e:
                return f"Error fetching user data: {str(e)}"

        return "I can help you fetch user data. Please provide a user ID."


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_api_service_mocking():
    """Test mocking HTTP calls within tools."""

    # Mock response data
    mock_response_data = {"id": "123", "name": "Alice", "email": "alice@example.com"}

    with patch("httpx.AsyncClient") as mock_client_class:
        # Setup the mock client and response
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        mock_response = AsyncMock()
        mock_response.json.return_value = mock_response_data
        mock_client.get.return_value = mock_response

        result = await scenario.run(
            name="api service test",
            description="Test tool's HTTP integration with mocked API calls",
            agents=[
                UserDataAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Get user data for ID 123"),
                scenario.agent(),
                lambda state: mock_client.get.assert_called_once_with(
                    "https://api.example.com/users/123"
                ),
                scenario.succeed(),
            ],
        )

        assert result.success
