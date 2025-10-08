"""
Example test for Azure OpenAI with API Management/Gateway.

This example demonstrates how to use Scenario with a custom OpenAI client
configured for Azure API Management (APIM) or other gateway services that
require custom authentication headers and base URLs.

Use cases:
- Azure API Management gateway in front of OpenAI
- Corporate proxies with custom authentication
- Rate limiting or monitoring layers
- Any custom middleware between your app and the LLM provider
"""

import os
import pytest
import scenario
from openai import OpenAI


def create_custom_openai_client():
    """
    Creates an OpenAI client configured for Azure API Management.

    This function demonstrates how to customize the OpenAI client for:
    1. Custom base URLs (e.g., Azure APIM endpoint)
    2. API versioning via query parameters
    3. Custom authentication headers (instead of standard Bearer tokens)

    Example environment variables (customize names as needed):
    - AZURE_GATEWAY_API_BASE: The full base URL of your Azure APIM endpoint (e.g., "https://my-gateway.azure-api.net")
    - AZURE_GATEWAY_API_VERSION: Azure OpenAI API version (e.g., "2024-05-01-preview")
    - AZURE_GATEWAY_HEADER_KEY_NAME: The name of the auth header (e.g., "Ocp-Apim-Subscription-Key")
    - AZURE_GATEWAY_HEADER_KEY_VALUE: The actual API key/subscription key value (e.g., "1234567890")

    Note: These variable names are suggestions only - use whatever fits your setup.

    Returns:
        OpenAI: Configured client instance for use with UserSimulatorAgent and JudgeAgent
    """
    # Load gateway configuration from environment
    # Customize these environment variable names to match your infrastructure
    base_url = os.getenv("AZURE_GATEWAY_API_BASE")
    api_version = os.getenv("AZURE_GATEWAY_API_VERSION")
    header_key_name = os.getenv("AZURE_GATEWAY_HEADER_KEY_NAME")
    header_key_value = os.getenv("AZURE_GATEWAY_HEADER_KEY_VALUE")

    # Debug logging to verify configuration (helpful for troubleshooting)
    print(f"base_url: {base_url}")
    print(f"header_key_name: {header_key_name}")
    print(f"header_key_value: {header_key_value}")
    print(f"api_version: {api_version}")

    # Create OpenAI client with custom configuration
    # The OpenAI SDK is flexible and allows overriding:
    # - base_url: Route requests through your gateway instead of api.openai.com
    # - default_query: Add query params to every request (needed for Azure API versioning)
    # - default_headers: Set custom auth headers (APIM, proxy credentials, etc.)
    return OpenAI(
        base_url=base_url,  # Override default OpenAI endpoint
        default_query={"api-version": api_version},  # Add API version to all requests
        default_headers=(
            {
                # Custom header for APIM authentication
                # Note: The header name can be anything your gateway expects
                # Common examples: "Ocp-Apim-Subscription-Key", "X-API-Key", "Authorization"
                header_key_name: header_key_value,
            }
            if header_key_name and header_key_value
            else None
        ),
    )


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_azure_gateway_with_custom_client():
    """
    Test that demonstrates using a custom OpenAI client with Scenario agents.

    This test shows:
    1. How to pass a custom OpenAI client to UserSimulatorAgent and JudgeAgent
    2. How to create a simple MockAgent for testing without external dependencies
    3. The basic scenario flow: user -> agent -> judge

    Key pattern: The custom client is passed to both UserSimulatorAgent and JudgeAgent
    so all LLM calls go through your configured gateway/proxy.
    """
    # Create the custom client configured for Azure APIM
    custom_client = create_custom_openai_client()

    # Define a mock agent to avoid dependencies on real agent implementations
    # This keeps the example focused on the custom client configuration
    class MockAgent(scenario.AgentAdapter):
        """
        A simple mock agent that echoes back the user's message.

        In production, replace this with your actual agent implementation
        (e.g., CrewAI, LangChain, custom agent, etc.)

        Note: Your agent doesn't need to use the custom client - only the
        UserSimulatorAgent and JudgeAgent need it since they make LLM calls.
        """

        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            # Extract the last user message from the conversation history
            user_message = input.last_new_user_message_str()
            # Return a simple response demonstrating the agent received the message
            return f"I don't know anything about {user_message}, but I will try to find out."

    # Run the scenario with all three agents
    result = await scenario.run(
        name="azure gateway test",
        description="User asks a simple question about the weather",
        agents=[
            # Your agent under test (mocked here for simplicity)
            MockAgent(),
            # UserSimulatorAgent generates realistic user inputs
            # IMPORTANT: Pass custom_client here to route its LLM calls through your gateway
            scenario.UserSimulatorAgent(model="gpt-4o-mini", client=custom_client),
            # JudgeAgent evaluates if the agent's response meets criteria
            # IMPORTANT: Pass custom_client here too so evaluation also uses your gateway
            scenario.JudgeAgent(
                model="gpt-4o-mini",
                criteria=[
                    "The agent responds to the user's message",
                    "The agent offers to help if they don't know the answer",
                ],
                client=custom_client,
            ),
        ],
        # Define the scenario script (the flow of interactions)
        script=[
            scenario.user(),  # UserSimulatorAgent generates a user message
            scenario.agent(),  # MockAgent responds to the user
            scenario.judge(),  # JudgeAgent evaluates if criteria are met
        ],
        set_id="python-examples",  # Group related test runs together in reporting
    )

    # Assert that the scenario succeeded (all criteria passed)
    try:
        assert result.success
    except Exception as e:
        # Print detailed information if the test fails for debugging
        # The result object contains the full conversation, judge feedback, etc.
        print(f"result: {result}")
        print(f"error: {e}")
        raise e
