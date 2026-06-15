import pytest
from unittest.mock import patch, MagicMock
from scenario import UserSimulatorAgent
from scenario.config import ModelConfig, ScenarioConfig
from scenario.types import AgentInput
from scenario.cache import context_scenario
from scenario.scenario_executor import ScenarioExecutor
from scenario.voice.modality_resolver import ModalityTier


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


@pytest.mark.asyncio
async def test_audio_in_simulator_retains_audio_parts():
    """AC1: audio-capable simulator (e.g. gpt-audio-mini) receives audio parts."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="gpt-audio-mini")

    user_sim = UserSimulatorAgent()

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Voice test scenario"

    audio_part = {"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}}
    text_part = {"type": "text", "text": "Hello"}
    agent_input = AgentInput(
        thread_id="test",
        messages=[
            {"role": "assistant", "content": [audio_part, text_part]},  # type: ignore[arg-type]
        ],
        new_messages=[],
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "I need help"

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.user_simulator_agent.resolve_modality",
            return_value=(ModalityTier.AUDIO_IN, []),
        ), patch(
            "scenario.user_simulator_agent.litellm.completion",
            return_value=mock_response,
        ) as mock_completion:
            await user_sim.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            messages_sent = call_kwargs["messages"]

            # Find the message with list content (after reverse_roles, was assistant turn)
            content_parts = None
            for msg in messages_sent:
                content = msg.get("content")
                if isinstance(content, list):
                    content_parts = content
                    break

            assert content_parts is not None, "No list-content message found in payload"
            types_present = [p.get("type") for p in content_parts if isinstance(p, dict)]
            assert "input_audio" in types_present, (
                f"Expected input_audio part to be retained for AUDIO_IN tier; got types: {types_present}"
            )
            assert "text" in types_present, (
                f"Expected text part to be retained; got types: {types_present}"
            )
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_text_simulator_strips_audio_with_placeholders():
    """AC2: text-only simulator strips audio parts and inserts placeholders."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4.1-mini")

    user_sim = UserSimulatorAgent()

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Text test scenario"

    audio_part = {"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}}
    text_part = {"type": "text", "text": "Hello from agent"}
    agent_input = AgentInput(
        thread_id="test",
        messages=[
            # assistant turn with both audio and text — voiced agent turn
            {"role": "assistant", "content": [audio_part, text_part]},  # type: ignore[arg-type]
            # user turn with audio only
            {"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": "BBBB", "format": "wav"}}]},
        ],
        new_messages=[],
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "What can you do?"

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.user_simulator_agent.resolve_modality",
            return_value=(ModalityTier.TEXT, []),
        ), patch(
            "scenario.user_simulator_agent.litellm.completion",
            return_value=mock_response,
        ) as mock_completion:
            await user_sim.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            messages_sent = call_kwargs["messages"]

            # Confirm no input_audio parts appear anywhere in the payload
            for msg in messages_sent:
                content = msg.get("content")
                if isinstance(content, list):
                    for part in content:
                        assert part.get("type") != "input_audio", (
                            f"input_audio must be stripped for TEXT tier; found in msg: {msg}"
                        )

            # Confirm placeholders are present (echo-safety: "[the agent said: ...]" for
            # assistant+audio+text; "[audio message]" for audio-only turns)
            all_text = " ".join(
                msg["content"]
                for msg in messages_sent
                if isinstance(msg.get("content"), str)
            )
            assert "[the agent said:" in all_text or "[audio message]" in all_text, (
                f"Expected placeholder text in stripped messages; got: {all_text!r}"
            )
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None
