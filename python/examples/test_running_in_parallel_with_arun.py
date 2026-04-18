"""Migration-path example: run scenarios concurrently via ``scenario.arun``.

This file is the async-native counterpart of
``examples/test_running_in_parallel.py``. Whenever an agent holds a
loop-bound resource (ADK ``InMemoryRunner``, a gRPC channel built in
a pytest fixture, a Firestore client, etc.) prefer ``arun`` over
``run``:

- ``arun`` runs the scenario on the pytest-asyncio event loop, so any
  singleton created by a fixture on that loop stays usable.
- Parallelism comes from ``pytest-asyncio-concurrent``'s
  ``@pytest.mark.asyncio_concurrent(group=...)`` marker — two sibling
  tests in the same group interleave on the same loop.

The test body is the same vegetarian-recipe agent; only the call site
changed: ``await scenario.arun(...)`` instead of ``await scenario.run(...)``.
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


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent_arun")
async def test_vegetarian_recipe_agent_via_arun():
    result = await scenario.arun(
        name="dinner idea (arun)",
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
                    "The agent should NOT ask more than two follow-up questions",
                ]
            ),
        ],
        max_turns=12,
        set_id="python-examples",
    )
    assert result.success


@pytest.mark.agent_test
@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent_arun")
@pytest.mark.flaky(reruns=3)
async def test_user_is_hungry_via_arun():
    # Follow-up prompts are fixed strings rather than free-form
    # ``scenario.user()`` calls so the UserSimulator's LLM noise
    # can't pivot the conversation away from vegetarian criteria
    # the judge checks.
    result = await scenario.arun(
        name="hungry user (arun)",
        description="User is very very hungry and wants a big, filling meal",
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
        script=[
            scenario.user("I'm starving! I need something really filling for dinner tonight"),
            scenario.agent(),
            scenario.user("That sounds great, can you share the recipe?"),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )
    assert result.success
