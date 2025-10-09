"""
Example test demonstrating LLM provider mocking using dependency injection.

This example shows how to mock LLM responses by injecting a mock LLM client
into the agent, avoiding global mocking that affects the entire framework.
"""

import pytest
import scenario
from unittest.mock import Mock


class MockLLM:
    """Mock LLM client that returns deterministic responses."""

    def __init__(self):
        self.call_count = 0
        self.last_messages = None
        self.last_model = None

    def completion(self, model: str, messages: list) -> Mock:
        """Mock completion method that returns deterministic responses."""
        self.call_count += 1
        self.last_messages = messages
        self.last_model = model

        # Create mock response structure
        mock_response = Mock()
        mock_message = Mock()
        mock_message.content = "I can help you with that request."
        mock_choice = Mock()
        mock_choice.message = mock_message
        mock_response.choices = [mock_choice]

        return mock_response


class ChatAgent(scenario.AgentAdapter):
    """Chat agent that accepts an LLM client (real or mock) via dependency injection."""

    def __init__(self, llm_client=None):
        self.llm_client = llm_client

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Use the injected LLM client (could be real litellm or our mock)
        assert self.llm_client is not None, "LLM client must be provided"
        response = self.llm_client.completion(
            model="openai/gpt-4o-mini",
            messages=input.messages,
        )

        return response.choices[0].message.content or ""


def check_specific_response(state: scenario.ScenarioState) -> None:
    """Check that the agent responded with expected mocked content."""
    last_msg = state.last_message()
    if last_msg["role"] == "assistant":
        content = last_msg.get("content", "")
        assert content == "I can help you with that request."


def check_mock_was_called_correctly(mock_llm: MockLLM) -> None:
    """Check that the mock LLM was called with expected parameters."""
    assert mock_llm.last_messages is not None, "Mock was not called"
    assert mock_llm.call_count == 1
    assert mock_llm.last_model == "openai/gpt-4o-mini"
    assert len(mock_llm.last_messages) == 2
    assert mock_llm.last_messages[0]["role"] == "user"
    assert "Hello there!" in mock_llm.last_messages[0]["content"]


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_llm_provider_mocking():
    """Test agent behavior using a mock LLM client."""

    # Create our mock LLM client
    mock_llm = MockLLM()

    result = await scenario.run(
        name="llm mock test",
        description="Test agent behavior with mock LLM client",
        agents=[
            ChatAgent(llm_client=mock_llm),
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
        ],
        script=[
            scenario.user("Hello there!"),
            scenario.agent(),
            # Verify the mock LLM was called with expected parameters
            lambda state: check_mock_was_called_correctly(mock_llm),
            # Verify we got the expected mocked response
            check_specific_response,
            scenario.succeed(),
        ],
    )

    assert result.success
    # Additional verification outside the scenario
    assert mock_llm.call_count == 1
    assert mock_llm.last_model == "openai/gpt-4o-mini"
