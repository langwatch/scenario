"""
Example test for a weather agent.

This example demonstrates testing an AI agent that provides weather information.
"""

import pytest
import scenario
import litellm
from function_schema import get_function_schema


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_weather_agent():
    # Integrate with your agent
    class WeatherAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return weather_agent(input.messages)

    # Define any custom assertions
    def check_for_weather_tool_call(state: scenario.ScenarioState):
        assert state.has_tool_call("get_current_weather")

    # Run the scenario
    result = await scenario.run(
        name="checking the weather",
        description="""
            The user is planning a boat trip from Barcelona to Rome,
            and is wondering what the weather will be like.
        """,
        agents=[
            WeatherAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini"),
        ],
        script=[
            scenario.user(),
            scenario.agent(),
            check_for_weather_tool_call,
            scenario.succeed(),
        ],
    )

    # Assert the simulation was successful
    assert result.success


# Example agent implementation, without any frameworks
import litellm
import random
import json


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
        model="openai/gpt-4.1-mini",
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

    if message.tool_calls:
        tools_by_name = {tool.__name__: tool for tool in tools}
        tool_responses = []
        for tool_call in message.tool_calls:
            tool_call_name = tool_call.function.name
            tool_call_args = json.loads(tool_call.function.arguments)
            if tool_call_name in tools_by_name:
                tool_call_function = tools_by_name[tool_call_name]  # type: ignore
                tool_call_function_response = tool_call_function(**tool_call_args)
                tool_responses.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(tool_call_function_response),
                    }
                )
            else:
                raise ValueError(f"Tool {tool_call_name} not found")

        return weather_agent(
            messages,
            [
                *response_messages,
                message,
                *tool_responses,
            ],
        )

    return [*response_messages, message]  # type: ignore
