"""
Example test demonstrating API/service mocking with real LLM tool calling.

This example shows how to mock HTTP calls within tools while using actual
LLM tool calling mechanisms to test realistic agent behavior.
"""

import pytest
import scenario
from unittest.mock import patch, AsyncMock
import litellm
import json
import httpx


async def fetch_user_data(user_id: str) -> dict:
    """Fetch user data from external API."""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"https://api.example.com/users/{user_id}")
        return response.json()


class UserDataAgent(scenario.AgentAdapter):
    """Agent that uses real LLM tool calling to fetch data from external APIs."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Define the API tool schema for the LLM
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": "fetch_user_data",
                    "description": "Fetch user data from external API by user ID",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "user_id": {
                                "type": "string",
                                "description": "The unique identifier for the user",
                            }
                        },
                        "required": ["user_id"],
                    },
                },
            }
        ]

        # Let the LLM decide when and how to call the API tool
        # The LLM will extract user_id from the user's natural language request
        response = litellm.completion(
            model="openai/gpt-4o-mini",
            messages=input.messages,
            tools=tool_schemas,
            tool_choice="auto",  # LLM decides when to use tools
        )

        message = response.choices[0].message  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Handle any tool calls the LLM decided to make
        if message.tool_calls:
            tool_responses = []

            for tool_call in message.tool_calls:
                tool_name = tool_call.function.name
                # LLM provides the arguments (user_id) extracted from user input
                args = json.loads(tool_call.function.arguments)

                # Execute the appropriate tool function
                if tool_name == "fetch_user_data":
                    try:
                        # Call the actual API tool with LLM-extracted parameters
                        # This is where our HTTP mocking takes effect
                        tool_result = await fetch_user_data(**args)
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": json.dumps(tool_result),
                            }
                        )
                    except Exception as e:
                        # Handle API call errors gracefully
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": f"Error: {str(e)}",
                            }
                        )

            # If tools were called, get the LLM's final response based on API results
            if tool_responses:
                follow_up_response = litellm.completion(
                    model="openai/gpt-4o-mini",
                    messages=input.messages + [message] + tool_responses,
                )
                return follow_up_response.choices[0].message.content or ""  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Return the LLM's direct response if no tools were called
        return message.content or ""


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_api_service_mocking():
    """Test mocking HTTP calls within tools while using real LLM tool calling."""

    # Mock response data that the "API" will return
    mock_response_data = {"id": "123", "name": "Alice", "email": "alice@example.com"}

    # Mock the HTTP client at the service level, not the agent level
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
                # User makes a natural language request
                scenario.user("Get user data for ID 123"),
                # Agent uses LLM to understand request and call appropriate tools
                scenario.agent(),
                # Verify the HTTP mock was called with specific URL extracted by the LLM
                # This proves the LLM correctly:
                # 1. Decided to use the fetch_user_data tool
                # 2. Extracted "123" as the user_id parameter from natural language
                # 3. Tool constructed the correct API URL with that parameter
                lambda state: mock_client.get.assert_called_once_with(
                    "https://api.example.com/users/123"
                ),
                scenario.succeed(),
            ],
        )

        assert result.success
