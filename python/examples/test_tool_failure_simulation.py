"""
Example test demonstrating tool failure simulation with real LLM tool calling.

This example shows how to test agent resilience by simulating tool failures,
timeouts, and other error conditions while using actual LLM tool calling.
"""

import pytest
import scenario
from unittest.mock import patch
import litellm
import json


def call_external_service(endpoint: str) -> str:
    """Call an external service."""
    # This would normally make an external API call
    raise NotImplementedError("This should be mocked in tests")


class ResilientAgent(scenario.AgentAdapter):
    """Agent that uses real LLM tool calling and handles external service failures gracefully."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Define the external service tool schema for the LLM
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": "call_external_service",
                    "description": "Call an external service API endpoint",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "endpoint": {
                                "type": "string",
                                "description": "The API endpoint to call",
                            }
                        },
                        "required": ["endpoint"],
                    },
                },
            }
        ]

        # Let the LLM decide when and how to call the external service tool
        response = litellm.completion(
            model="openai/gpt-4o-mini",
            messages=input.messages,
            tools=tool_schemas,
            tool_choice="auto",
        )

        message = response.choices[0].message  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Handle any tool calls the LLM decided to make
        if message.tool_calls:
            tool_responses = []

            for tool_call in message.tool_calls:
                tool_name = tool_call.function.name
                # LLM provides the arguments (endpoint) extracted from user input
                args = json.loads(tool_call.function.arguments)

                # Execute the appropriate tool function
                if tool_name == "call_external_service":
                    try:
                        # Call the actual external service tool with LLM-extracted parameters
                        # This is where our failure simulation takes effect
                        tool_result = call_external_service(**args)
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": str(tool_result),
                            }
                        )
                    except Exception as e:
                        # Handle service call errors gracefully - this is what we're testing
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": f"Error: {str(e)}",
                            }
                        )

            # If tools were called, get the LLM's final response based on service results
            if tool_responses:
                follow_up_response = litellm.completion(
                    model="openai/gpt-4o-mini",
                    messages=input.messages + [message] + tool_responses,
                )
                return follow_up_response.choices[0].message.content or ""  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Return the LLM's direct response if no tools were called
        return message.content or ""


def check_error_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains error or timeout information."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        # Check for various error indicators the LLM might use
        error_indicators = ["error", "timeout", "timed out", "failed", "issue"]
        content_str = content if isinstance(content, str) else str(content)
        assert any(indicator in content_str.lower() for indicator in error_indicators)


def check_rate_limit_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains rate limit error information."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        # Check for various rate limit indicators the LLM might use
        rate_limit_indicators = [
            "rate limit",
            "exceeded",
            "limit exceeded",
            "too many requests",
        ]
        content_str = content if isinstance(content, str) else str(content)
        assert any(
            indicator in content_str.lower() for indicator in rate_limit_indicators
        )


def check_success_in_message(state: scenario.ScenarioState) -> None:
    """Check that the agent's message contains success information."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        # Check for various success indicators the LLM might use
        success_indicators = [
            "successful",
            "success",
            "completed",
            "call was successful",
        ]
        content_str = content if isinstance(content, str) else str(content)
        assert any(indicator in content_str.lower() for indicator in success_indicators)


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
                scenario.user("Call the external service at endpoint /api/data"),
                scenario.agent(),
                # Verify the mock was called with specific endpoint extracted by the LLM
                # This proves the LLM correctly extracted "/api/data" from the user message
                lambda state: mock_service.assert_called_once_with(
                    endpoint="/api/data"
                ),
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
                scenario.user("Call the external service at endpoint /api/data"),
                scenario.agent(),
                # Verify the mock was called with specific endpoint extracted by the LLM
                # This proves the LLM correctly extracted "/api/data" from the user message
                lambda state: mock_service.assert_called_once_with(
                    endpoint="/api/data"
                ),
                check_rate_limit_in_message,
                scenario.succeed(),
            ],
        )

        assert result.success


@pytest.mark.agent_test
@pytest.mark.flaky(reruns=2)
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
                scenario.user("Call the external service at endpoint /api/data"),
                scenario.agent(),
                # Verify the mock was called with specific endpoint extracted by the LLM
                # This proves the LLM correctly extracted "/api/data" from the user message
                lambda state: mock_service.assert_called_once_with(
                    endpoint="/api/data"
                ),
                check_success_in_message,
                scenario.succeed(),
            ],
        )

        assert result.success
