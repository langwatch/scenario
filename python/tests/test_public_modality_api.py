"""AC0: per-role modality declaration via public API."""
import inspect
import pytest
from unittest.mock import patch, MagicMock

from scenario.voice.modality_resolver import ModalityTier


def test_ac0_modality_parameter_documented():
    """AC0: modality parameter appears in the __init__ signature of both agents."""
    from scenario.user_simulator_agent import UserSimulatorAgent
    sig = inspect.signature(UserSimulatorAgent.__init__)
    assert 'modality' in sig.parameters

    from scenario.judge_agent import JudgeAgent
    sig = inspect.signature(JudgeAgent.__init__)
    assert 'modality' in sig.parameters


def test_ac0_no_modality_defaults_to_none_declaration():
    """AC0: no modality= defaults to self.modality = None (advisory-only path)."""
    from scenario.user_simulator_agent import UserSimulatorAgent
    sim = UserSimulatorAgent(model="gpt-4o")
    assert sim.modality is None


def test_ac0_judge_modality_declaration_stored():
    """AC0: modality= on JudgeAgent is stored on self.modality."""
    from scenario.judge_agent import JudgeAgent
    judge = JudgeAgent(model="gpt-4o", modality="text")
    assert judge.modality == "text"


def test_ac0_judge_modality_declaration_reaches_resolver():
    """AC0: modality= on JudgeAgent reaches resolve_modality as declaration arg."""
    from scenario.judge_agent import JudgeAgent
    judge = JudgeAgent(model="gpt-4o", modality="text")

    with patch('scenario.judge_agent.resolve_modality') as mock_resolver:
        mock_resolver.return_value = (ModalityTier.TEXT, [])
        result = judge.effective_include_audio(conversation_has_audio=True)
        mock_resolver.assert_called_once_with(declaration="text", model_id="gpt-4o")
        assert result is False  # TEXT tier -> no audio


@pytest.mark.asyncio
async def test_ac0_simulator_modality_declaration_reaches_resolver():
    """AC0: modality= on UserSimulatorAgent reaches resolve_modality as declaration arg."""
    from scenario.user_simulator_agent import UserSimulatorAgent
    from scenario.types import AgentInput
    from scenario.cache import context_scenario

    sim = UserSimulatorAgent(model="gpt-4o", modality="audio-in")
    assert sim.modality == "audio-in"

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"

    agent_input = AgentInput(
        thread_id="test",
        messages=[],
        new_messages=[],
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "hello"

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch('scenario.user_simulator_agent.resolve_modality') as mock_resolver, \
             patch('scenario.user_simulator_agent.litellm.completion', return_value=mock_response):
            mock_resolver.return_value = (ModalityTier.AUDIO_IN, [])
            await sim._generate_text(agent_input)
            mock_resolver.assert_called_once_with(declaration="audio-in", model_id="gpt-4o")
    finally:
        context_scenario.reset(token)
