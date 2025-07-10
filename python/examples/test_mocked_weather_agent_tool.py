"""
Example test for a weather agent with mocked tool call and result.

This example demonstrates testing an AI agent that provides weather information.
"""

import pytest
import scenario
import litellm
from function_schema import get_function_schema


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_mocked_weather_agent_tool():
    # Integrate with your agent
    class WeatherAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return weather_agent(input.messages)

    # Run the scenario
    result = await scenario.run(
        name="checking the weather",
        description="""
            The user is planning a boat trip from Barcelona to Rome,
            and is wondering what the weather will be like.
        """,
        agents=[
            WeatherAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1"),
        ],
        script=[
            scenario.message(
                {"role": "user", "content": "What's the weather in Paris?"}
            ),
            scenario.message(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_123",
                            "function": {
                                "name": "get_current_weather",
                                "arguments": '{"location": "Paris"}',
                            },
                            "type": "function",
                        }
                    ],
                }
            ),
            scenario.message(
                {
                    "role": "tool",
                    "tool_call_id": "call_123",
                    "content": "The weather in Paris is sunny and 75°F.",
                }
            ),
            scenario.agent(),
            scenario.succeed(),
        ],
        set_id="python-examples",
    )

    # Assert the simulation was successful
    assert result.success


# Example agent implementation, without any frameworks
import litellm
import random


def get_current_weather(city: str) -> str:
    """
    Get the current weather in a given city.

    Args:
        city: The city to get the weather for.

    Returns:
        The current weather in the given city.
    """

    choices = [
        "sunny",
        "cloudy",
        "rainy",
        "snowy",
    ]
    temperature = random.randint(0, 30)
    return f"The weather in {city} is {random.choice(choices)} with a temperature of {temperature}°C."


@scenario.cache()
def weather_agent(messages, response_messages=[]) -> scenario.AgentReturnTypes:
    tools = [
        get_current_weather,
    ]

    response = litellm.completion(
        model="openai/gpt-4.1",
        messages=[
            {
                "role": "system",
                "content": """
                    You a helpful assistant that may help the user with weather information.
                    Do not guess the city if they don't provide it.
                """,
            },
            *messages,
            *response_messages,
        ],
        tools=[
            {"type": "function", "function": get_function_schema(tool)}
            for tool in tools
        ],
        tool_choice="auto",
    )

    message = response.choices[0].message  # type: ignore

    return [*response_messages, message]  # type: ignore
