from typing import Any, cast

import pytest
from scenario.types import ScenarioResult
from openai.types.chat import ChatCompletionUserMessageParam

from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentRole


@pytest.mark.asyncio
async def test_should_be_able_to_override_scenario_agent():
    class MyCustomTestingAgent(AgentAdapter):
        triggers = {AgentRole.AGENT}

        async def call(self, input: AgentInput):
            return ScenarioResult(
                success=True,
                reasoning="",
                passed_criteria=[],
                messages=[
                    ChatCompletionUserMessageParam(
                        role="user", content="Hello, how can I help you?"
                    )
                ],
            )

    input = AgentInput(
        thread_id="1",
        messages=[],
        new_messages=[],
        judgment_request=False,
        scenario_state=cast(Any, None),
    )

    agent = MyCustomTestingAgent()
    assert agent.triggers == {AgentRole.AGENT}
    assert (await agent.call(input)).success
