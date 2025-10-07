"""
Example test for Azure OpenAI with API Management/Gateway.
"""

import os
import pytest
import scenario
from openai import OpenAI


def create_custom_openai_client():
    base_url = os.getenv("AZURE_GATEWAY_API_BASE")
    api_version = "2024-05-01-preview"
    header_key_name = os.getenv("AZURE_GATEWAY_HEADER_KEY_NAME")
    header_key_value = os.getenv("AZURE_GATEWAY_HEADER_KEY_VALUE")

    print(f"base_url: {base_url}")
    print(f"header_key_name: {header_key_name}")
    print(f"header_key_value: {header_key_value}")
    print(f"api_version: {api_version}")

    return OpenAI(
        base_url=base_url,
        default_query={"api-version": api_version},
        default_headers={
            "api_key": header_key_value,
        },
    )


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_azure_gateway_with_custom_client():
    custom_client = create_custom_openai_client()

    # For this test, we'll use a mock agent instead
    class MockAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            user_message = input.last_new_user_message_str()
            return f"I understand you're asking about: {user_message}"

    result = await scenario.run(
        name="azure gateway test",
        description="User asks a simple question about the weather",
        agents=[
            MockAgent(),
            scenario.UserSimulatorAgent(model="gpt-4o-mini", client=custom_client),
            scenario.JudgeAgent(
                model="gpt-4o-mini",
                criteria=["Agent provides helpful response"],
                client=custom_client,
            ),
        ],
        script=[
            scenario.user(),
            scenario.agent(),
            scenario.succeed(),
        ],
        set_id="python-examples",
    )

    try:
        assert result.success
    except Exception as e:
        print(f"result: {result}")
        print(f"error: {e}")
        raise e
