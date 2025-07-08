import pytest
from unittest.mock import patch, MagicMock
from scenario.types import AgentInput
from scenario.config import ModelConfig
from typing import Optional


class UserSimulatorAgent:
    def __init__(self, *, model: str, api_base: Optional[str]):
        self.model = model
        self.api_base = api_base or ""

    async def call(self, input: AgentInput):
        from litellm import completion

        completion(model=self.model, messages=[], api_base=self.api_base)


def test_modelconfig_api_base_field():
    config = ModelConfig(model="foo", api_base="https://bar.com")
    assert config.api_base == "https://bar.com"


@pytest.mark.asyncio
async def test_user_simulator_agent_uses_modelconfig_api_base():
    model_config = ModelConfig(
        model="openai/gpt-4.1", api_base="https://custom-api-base.example.com"
    )
    agent = UserSimulatorAgent(model=model_config.model, api_base=model_config.api_base)
    agent_input = MagicMock(spec=AgentInput)
    with patch("litellm.completion") as mock_completion:
        await agent.call(agent_input)
        assert mock_completion.called
        assert (
            mock_completion.call_args.kwargs["api_base"]
            == "https://custom-api-base.example.com"
        )
