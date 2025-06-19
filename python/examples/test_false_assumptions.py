from typing import cast
import litellm
import pytest

from openai.types.chat import ChatCompletionMessageParam
import scenario

scenario.configure(default_model="openai/gpt-4.1-nano")


class Agent(scenario.AgentAdapter):
    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        response = litellm.completion(
            model="openai/gpt-4.1-nano",
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant",
                },
                *input.messages,
            ],
        )
        message = response.choices[0].message  # type: ignore

        return [cast(ChatCompletionMessageParam, message)]


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_early_assumption_bias():
    result = await scenario.run(
        name="early assumption bias",
        description="""
            The agent makes false assumption that the user is talking about an ATM bank, and user corrects it that they actually mean river banks
        """,
        agents=[
            Agent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "user should get good recommendations on river crossing",
                    "agent should NOT keep following up about ATM recommendation after user has corrected them that they are actually just hiking",
                ],
            ),
        ],
        max_turns=10,
        script=[
            # Define hardcoded messages
            scenario.agent("Hello, how can I help you today?"),
            scenario.user("how do I safely approach a bank?"),

            # Or let it be generated automatically
            scenario.agent(),

            # Generate a user follow-up message
            scenario.user(),

            # Let the simulation proceed for 2 more turns, print at every turn
            scenario.proceed(
                turns=2,
                on_turn=lambda state: print(f"Turn {state.current_turn}: {state.messages}"),
            ),

            # Time to make a judgment call
            scenario.judge(),
        ],
    )

    assert result.success
