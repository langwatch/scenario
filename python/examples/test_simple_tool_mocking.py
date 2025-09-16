"""
Example test demonstrating PROPER tool function mocking with real tool calling.

This example shows how to mock tool functions while using actual
LLM tool calling mechanisms, not hardcoded logic.
"""

import pytest
import scenario
from unittest.mock import patch
import litellm
import json


def fetch_user_data(user_id: str) -> dict:
    """Fetch user data from external API."""
    # This would normally make an API call
    raise NotImplementedError("This should be mocked in tests")


class UserDataAgent(scenario.AgentAdapter):
    """Agent that uses actual LLM tool calling, not hardcoded logic."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        tools = [fetch_user_data]

        # Define tool schema for LLM
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": "fetch_user_data",
                    "description": "Fetch user data from external API",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "user_id": {
                                "type": "string",
                                "description": "The user ID to fetch data for",
                            }
                        },
                        "required": ["user_id"],
                    },
                },
            }
        ]

        # Let LLM decide when and how to call tools
        response = litellm.completion(
            model="openai/gpt-4o-mini",
            messages=input.messages,
            tools=tool_schemas,
            tool_choice="auto",
        )

        message = response.choices[0].message

        # Handle tool calls if LLM made any
        if message.tool_calls:
            tool_responses = []

            for tool_call in message.tool_calls:
                tool_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)

                # Find and execute the tool function
                if tool_name == "fetch_user_data":
                    try:
                        tool_result = fetch_user_data(**args)
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": json.dumps(tool_result),
                            }
                        )
                    except Exception as e:
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": f"Error: {str(e)}",
                            }
                        )

            # Continue conversation with tool results
            if tool_responses:
                follow_up_response = litellm.completion(
                    model="openai/gpt-4o-mini",
                    messages=input.messages + [message] + tool_responses,
                )
                return follow_up_response.choices[0].message.content or ""

        return message.content or ""


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_simple_tool_mocking():
    """Test mocking tools while using real LLM tool calling."""

    with patch("test_simple_tool_mocking.fetch_user_data") as mock_fetch:
        # Setup mock return value
        mock_fetch.return_value = {
            "name": "Alice",
            "points": 150,
            "email": "alice@example.com",
        }

        result = await scenario.run(
            name="user data tool test",
            description="Test agent's actual tool calling with mocked tool implementation",
            agents=[
                UserDataAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                scenario.user("Show me user data for ID 123"),
                scenario.agent(),
                # Verify the mock was called (LLM should extract "123" from user message)
                lambda state: mock_fetch.assert_called_once(),
                scenario.succeed(),
            ],
        )

        assert result.success
