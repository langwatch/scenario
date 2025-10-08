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


def test_modelconfig_accepts_extra_litellm_params():
    """ModelConfig accepts arbitrary litellm parameters via extra='allow'."""
    from openai import OpenAI

    custom_client = MagicMock(spec=OpenAI)

    config = ModelConfig(
        model="openai/gpt-4",
        api_base="https://custom.com",
        headers={"X-Custom-Header": "test-value"},  # type: ignore  # extra param via ConfigDict(extra="allow")
        timeout=60,  # type: ignore  # extra param via ConfigDict(extra="allow")
        num_retries=3,  # type: ignore  # extra param via ConfigDict(extra="allow")
        client=custom_client,  # type: ignore  # extra param via ConfigDict(extra="allow")
    )

    assert config.model == "openai/gpt-4"
    assert config.api_base == "https://custom.com"

    # Verify extra params are stored
    dump = config.model_dump()
    assert dump["headers"] == {"X-Custom-Header": "test-value"}
    assert dump["timeout"] == 60
    assert dump["num_retries"] == 3
    assert dump["client"] == custom_client
