"""
Example test for a weather agent (Gemini version).

This example demonstrates testing an AI agent that provides weather information using Gemini via litellm,
and uses a Gemini-powered JudgeAgent.
"""

import pytest
import scenario
import litellm
from function_schema import get_function_schema

from scenario.judge_agent import JudgeAgent


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_weather_agent():
    # Integrate with your agent
    class WeatherAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return weather_agent(input.messages)

    # Set up JudgeAgent with Gemini model and minimum helpfulness criteria
    judge = JudgeAgent(
        model="gemini/gemini-2.5-flash",
        criteria=[
            "The agent uses the get_current_weather tool to answer the question.",
            "The agent does not guess the city if the user does not provide it.",
            "The agent provides helpful weather information in response to the user's inquiry.",
        ],
        temperature=0.0,  # deterministic for judging
    )

    # Run the scenario
    result = await scenario.run(
        name="checking the weather (Gemini+Judge)",
        description="""
            The user is planning a boat trip from Barcelona to Rome,
            and is wondering what the weather will be like.
        """,
        agents=[
            WeatherAgent(),
            scenario.UserSimulatorAgent(model="gemini/gemini-2.5-flash"),
            judge,
        ],
        script=[
            scenario.user(),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    # Assert the simulation was successful according to the judge
    assert result.success


# Example agent implementation, using Gemini via litellm
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
        model="gemini/gemini-2.5-flash",
        messages=[
            {
                "role": "system",
                "content": """
                    You are a helpful assistant that may help the user with weather information.
                    Do not guess the city if they don't provide it. Get the weather for multiple cities if they ask for it.
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

    if hasattr(message, "tool_calls") and message.tool_calls:
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
