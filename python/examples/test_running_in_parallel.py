"""
Example test for a vegetarian recipe agent.

This example demonstrates testing an AI agent that generates vegetarian recipes.
"""

from typing import cast
import pytest
from dotenv import load_dotenv
import litellm

from openai.types.chat import ChatCompletionMessageParam
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes

load_dotenv()

import scenario

scenario.configure(default_model="openai/gpt-4.1-mini")


class VegetarianRecipeAgentAdapter(AgentAdapter):
    @scenario.cache()
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        response = litellm.completion(
            model="openai/gpt-4.1-mini",
            messages=[
                {
                    "role": "system",
                    "content": """You are a vegetarian recipe agent.
                    Given the user request, ask AT MOST ONE follow-up question,
                    then provide a complete recipe. Keep your responses concise and focused.""",
                },
                *input.messages,
            ],
        )
        message = response.choices[0].message  # type: ignore

        return [cast(ChatCompletionMessageParam, message)]


@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent")
async def test_vegetarian_recipe_agent():
    # Define the scenario
    result = await scenario.run(
        name="dinner idea",
        description="User is looking for a dinner idea",
        agents=[
            VegetarianRecipeAgentAdapter(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "Recipe agent generates a vegetarian recipe",
                    "Recipe includes a list of ingredients",
                    "Recipe includes step-by-step cooking instructions",
                    "The recipe is vegetarian and does not include meat",
                    "The should NOT ask more than two follow-up questions",
                ]
            ),
        ],
        max_turns=5,
    )

    # Assert for pytest to know whether the test passed
    assert result.success


@pytest.mark.agent_test
@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent")
async def test_user_is_hungry():
    # Define the scenario
    result = await scenario.run(
        name="hungry user",
        description="User is very very hungry, they say they could eat a cow",
        agents=[
            VegetarianRecipeAgentAdapter(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "Recipe agent generates a vegetarian recipe",
                    "Recipe includes a list of ingredients",
                    "Recipe includes step-by-step cooking instructions",
                    "The recipe is vegetarian and does not include meat",
                    "The agent should NOT ask more than two follow-up questions",
                ]
            ),
        ],
        max_turns=5,
    )

    # Assert for pytest to know whether the test passed
    assert result.success
