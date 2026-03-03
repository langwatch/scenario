"""
Example test demonstrating Level 1: Tool Function Mocking with real LLM tool calling.

This example shows how to mock tool functions while using actual LLM tool calling
mechanisms. This is the most common mocking pattern for modern agents.

What we're testing:
- Agent reasoning and tool selection logic
- LLM's ability to extract parameters from natural language
- Tool orchestration and response handling

What we're NOT testing:
- The actual tool implementation (that's mocked out)
- External API calls or database connections
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

        message = response.choices[0].message  # type: ignore[attr-defined]  # litellm response has dynamic attributes

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
                return follow_up_response.choices[0].message.content or ""  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        return message.content or ""


@pytest.mark.agent_test
@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_simple_tool_mocking():
    """Test mocking tools while using real LLM tool calling."""

    # Level 1: Mock the tool function itself, not any internal dependencies
    with patch("test_simple_tool_mocking.fetch_user_data") as mock_fetch:
        # Setup mock return value - what the tool should return when called
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
                # Verify the mock was called - proves the LLM correctly:
                # 1. Decided to use the fetch_user_data tool
                # 2. Extracted "123" as the user_id parameter from natural language
                lambda state: mock_fetch.assert_called_once_with(user_id="123"),
                scenario.succeed(),
            ],
        )

        assert result.success
