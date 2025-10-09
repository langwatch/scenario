import pytest
from unittest.mock import patch, MagicMock
from scenario import UserSimulatorAgent
from scenario.config import ModelConfig, ScenarioConfig
from scenario.types import AgentInput
from scenario.cache import context_scenario
from scenario.scenario_executor import ScenarioExecutor


@pytest.mark.asyncio
async def test_user_simulator_agent_merges_global_config_and_agent_params():
    """UserSimulatorAgent merges ModelConfig defaults with agent-specific overrides."""
    # Setup global config with extra params
    ScenarioConfig.default_config = ScenarioConfig(
        default_model=ModelConfig(
            model="openai/gpt-4",
            headers={"X-Auth": "token-123"},  # type: ignore  # extra param via ConfigDict(extra="allow")
            max_retries=5,  # type: ignore  # extra param via ConfigDict(extra="allow")
        )
    )

    user_sim = UserSimulatorAgent(
        temperature=0.7,
        num_retries=2,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"

    agent_input = AgentInput(
        thread_id="test",
        messages=[],
        new_messages=[],
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "test user message"

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.user_simulator_agent.litellm.completion",
            return_value=mock_response,
        ) as mock_completion:
            await user_sim.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs

            # Verify merged params
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["temperature"] == 0.7  # Agent override
            assert call_kwargs["headers"] == {"X-Auth": "token-123"}  # From config
            assert call_kwargs["max_retries"] == 5  # From config
            assert call_kwargs["num_retries"] == 2  # Agent-specific
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_user_simulator_agent_with_string_default_model_config():
    """UserSimulatorAgent should initialize _extra_params when default_model is a string."""
    # Setup global config with string default_model
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

    user_sim = UserSimulatorAgent(
        temperature=0.7,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"

    agent_input = AgentInput(
        thread_id="test",
        messages=[],
        new_messages=[],
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "test user message"

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.user_simulator_agent.litellm.completion",
            return_value=mock_response,
        ) as mock_completion:
            # This should not raise AttributeError: 'UserSimulatorAgent' object has no attribute '_extra_params'
            await user_sim.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["temperature"] == 0.7
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None
