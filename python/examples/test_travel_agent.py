"""
Example test for a weather agent.

This example demonstrates testing an AI agent that provides weather information.
"""

import pytest
import scenario
import litellm


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_travel_agent():
    # Integrate with your agent
    class TravelAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return travel_agent(input.messages)

    # Assertions that will be used to check for tool calls
    def check_for_weather_tool_call(state: scenario.ScenarioState):
        assert state.has_tool_call("get_current_weather")

    def check_for_accomodation_tool_call(state: scenario.ScenarioState):
        assert state.has_tool_call("get_accomodation")

    # Run the scenario
    result = await scenario.run(
        name="boat trip travel planning",
        description="""
            The user is planning a boat trip from Barcelona to Rome,
            and is wondering what the weather will be like.

            Then the user will ask for different accomodation options.
        """,
        agents=[
            TravelAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1"),
            scenario.JudgeAgent(
                model="openai/gpt-4.1",
                criteria=[
                    "The agent should ask which city is the user asking accomodations for if they don't provide it.",
                    "The agent should share the prices of each accomodation for the user to consider.",
                    "The agent should not bias the user towards a specific accomodation.",
                ],
            ),
        ],
        script=[
            scenario.user("check weather barcelona to rome next week"),
            scenario.agent(),
            check_for_weather_tool_call,
            scenario.user(),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            check_for_accomodation_tool_call,
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    # Assert the simulation was successful
    assert result.success


# Example agent implementation, without any frameworks
import litellm
import random
import json
from typing import Literal
from function_schema import get_function_schema


def get_current_weather(city: str, date_range: str) -> str:
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


def get_accomodation(
    city: str, weather: Literal["sunny", "cloudy", "rainy", "snowy"]
) -> list[str]:
    """
    Get the accomodation in a given city.

    Args:
        city: The city to get the accomodation for.
        weather: The weather in the city. One of: "sunny", "cloudy", "rainy", "snowy".

    Returns:
        The accomodation in the given city.
    """
    if weather == "sunny":
        return [
            "Water Park Inn - $100 per night",
            "Beach Resort La Playa - $150 per night",
            "Hotelito - $200 per night",
        ]
    elif weather == "cloudy" or weather == "rainy":
        return [
            "Hotel Barcelona - $100 per night",
            "Hotel Rome - $150 per night",
            "Hotel Venice - $200 per night",
        ]
    elif weather == "snowy":
        return [
            "Mountains Peak Lodge - $100 per night",
            "Snowy Mountain Inn - $150 per night",
            "Snowy Mountain Resort - $200 per night",
        ]
    else:
        raise ValueError(f"Invalid weather: {weather}")


@scenario.cache()
def travel_agent(messages, response_messages=[]) -> scenario.AgentReturnTypes:
    tools = [
        get_current_weather,
        get_accomodation,
    ]

    response = litellm.completion(
        model="openai/gpt-4.1",
        messages=[
            {
                "role": "system",
                "content": """
                    You are a helpful travel agent that helps the user with weather information and accomodation options, use the tools provided to you.
                    Do not guess the city if they don't provide it.
                    You can make multiple tool calls if they ask multiple cities.

                    Today is Friday, 25th July 2025.
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

        return travel_agent(
            messages,
            [
                *response_messages,
                message,
                *tool_responses,
            ],
        )

    return [*response_messages, message]  # type: ignore
