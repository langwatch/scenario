import pytest
from unittest.mock import patch, MagicMock
from openai import OpenAI
from scenario import JudgeAgent
from scenario.config import ModelConfig, ScenarioConfig
from scenario.types import AgentInput
from scenario.cache import context_scenario
from scenario.scenario_executor import ScenarioExecutor


class FakeOpenAIClient:
    """Fake client for testing without requiring API keys."""

    def __init__(self, base_url=None, default_headers=None):
        self.base_url = base_url
        self.default_headers = default_headers


@pytest.mark.asyncio
async def test_judge_agent_merges_global_config_and_agent_params():
    """JudgeAgent merges ModelConfig defaults with agent-specific overrides, including custom client."""
    # Setup custom client
    custom_client = FakeOpenAIClient(
        base_url="https://custom.com", default_headers={"X-Global": "global-value"}
    )

    # Setup global config with extra params
    ScenarioConfig.default_config = ScenarioConfig(
        default_model=ModelConfig(
            model="openai/gpt-4",
            api_base="https://custom.com",
            headers={"X-Global": "global-value"},  # type: ignore  # extra param via ConfigDict(extra="allow")
            timeout=30,  # type: ignore  # extra param via ConfigDict(extra="allow")
            client=custom_client,  # type: ignore  # extra param via ConfigDict(extra="allow")
        )
    )

    judge = JudgeAgent(
        criteria=["Test criterion"],
        temperature=0.5,
        timeout=60,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=True,
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "Test passed", "criteria": {"test_criterion": true}}'

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs

            # Verify merged params: config defaults + agent overrides
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["api_base"] == "https://custom.com"
            assert call_kwargs["temperature"] == 0.5  # Agent override
            assert call_kwargs["timeout"] == 60  # Agent override
            assert call_kwargs["headers"] == {"X-Global": "global-value"}  # From config
            assert (
                call_kwargs["client"] == custom_client
            )  # Custom client passed through
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_agent_with_string_default_model_config():
    """JudgeAgent should initialize _extra_params when default_model is a string."""
    # Setup global config with string default_model
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

    judge = JudgeAgent(
        criteria=["Test criterion"],
        temperature=0.5,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=True,
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "Test passed", "criteria": {"test_criterion": true}}'

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            # This should not raise AttributeError: 'JudgeAgent' object has no attribute '_extra_params'
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["temperature"] == 0.5
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None
