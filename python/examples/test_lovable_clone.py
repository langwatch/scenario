import pytest

from examples.lovable_clone.lovable_agent import LovableAgent
import scenario

scenario.configure(
    default_model="anthropic/claude-3-5-sonnet-latest",
)


class LovableAgentAdapter(scenario.AgentAdapter):
    def __init__(self, template_path: str):
        self.lovable_agent = LovableAgent(template_path)

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        _, messages = await self.lovable_agent.process_user_message(
            input.last_new_user_message_str()
        )

        return messages


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_lovable_clone():
    template_path = LovableAgent.clone_template()
    print(f"\n-> Lovable clone template path: {template_path}\n")

    result = await scenario.run(
        name="dog walking startup landing page",
        description="""
            the user wants to create a new landing page for their dog walking startup

            send the first message to generate the landing page, then a single follow up request to extend it, then give your final verdict
        """,
        agents=[
            LovableAgentAdapter(template_path=template_path),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "agent reads the files before go and making changes",
                    "agent modified the index.css file, not only the Index.tsx file",
                    "agent created a comprehensive landing page",
                    "agent extended the landing page with a new section",
                    "agent should NOT say it can't read the file",
                    "agent should NOT produce incomplete code or be too lazy to finish",
                ],
            ),
        ],
        max_turns=5, # optional
    )

    assert result.success
