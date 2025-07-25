"""
Example test for a vegetarian recipe agent.

This example demonstrates testing an AI agent that generates vegetarian recipes.
"""

import pytest
import scenario
import litellm

scenario.configure(default_model="openai/gpt-4.1")


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_vegetarian_recipe_agent():
    class Agent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return vegetarian_recipe_agent(input.messages)

    # Define the scenario
    result = await scenario.run(
        name="dinner idea",
        description="""
            It's saturday evening, the user is very hungry and tired,
            but have no money to order out, so they are looking for a recipe.
        """,
        agents=[
            Agent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "Agent should not ask more than two follow-up questions",
                    "Agent should generate a recipe",
                    "Recipe should include a list of ingredients",
                    "Recipe should include step-by-step cooking instructions",
                    "Recipe should be vegetarian and not include any sort of meat",
                ]
            ),
        ],
        script=[
            scenario.user("quick recipe for dinner"),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    # Assert for pytest to know whether the test passed
    assert result.success


# Example agent implementation
import litellm


@scenario.cache()
def vegetarian_recipe_agent(messages) -> scenario.AgentReturnTypes:
    response = litellm.completion(
        model="openai/gpt-4.1",
        messages=[
            {
                "role": "system",
                "content": """
                    You are a vegetarian recipe agent.
                    Given the user request, ask AT MOST ONE follow-up question,
                    then provide a complete recipe. Keep your responses concise and focused.
                """,
            },
            *messages,
        ],
    )

    return response.choices[0].message  # type: ignore
