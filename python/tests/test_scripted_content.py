import pytest

import scenario


class RecordingAgent(scenario.AgentAdapter):
    def __init__(self):
        self.inputs = []

    async def call(self, input: scenario.AgentInput) -> str:
        self.inputs.append(input)
        return "generated"


class RecordingUser(RecordingAgent):
    role = scenario.AgentRole.USER


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["", " ", "scripted"])
@pytest.mark.parametrize(
    "adapter_class,step,role",
    [
        (RecordingUser, scenario.user, "user"),
        (RecordingAgent, scenario.agent, "assistant"),
    ],
    ids=["user", "agent"],
)
async def test_scripted_strings_are_used_without_calling_the_adapter(
    adapter_class, step, role, text
):
    adapter = adapter_class()
    result = await scenario.run(
        name="scripted string",
        description="Use the supplied text verbatim",
        agents=[adapter],
        script=[step(text), scenario.succeed()],
        verbose=False,
    )

    assert result.success
    assert [
        (message["role"], message.get("content")) for message in result.messages
    ] == [(role, text)]
    assert adapter.inputs == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "adapter_class,step,role",
    [
        (RecordingUser, scenario.user, "user"),
        (RecordingAgent, scenario.agent, "assistant"),
    ],
    ids=["user", "agent"],
)
async def test_structured_empty_messages_are_used_without_calling_the_adapter(
    adapter_class, step, role
):
    adapter = adapter_class()
    result = await scenario.run(
        name="structured empty message",
        description="Keep the existing structured-message behavior",
        agents=[adapter],
        script=[step({"role": role, "content": ""}), scenario.succeed()],
        verbose=False,
    )

    assert result.success
    assert result.messages[-1]["role"] == role
    assert result.messages[-1].get("content") == ""
    assert adapter.inputs == []


@pytest.mark.asyncio
@pytest.mark.parametrize("omit_content", [False, True], ids=["none", "omitted"])
@pytest.mark.parametrize(
    "adapter_class,step,role",
    [
        (RecordingUser, scenario.user, "user"),
        (RecordingAgent, scenario.agent, "assistant"),
    ],
    ids=["user", "agent"],
)
async def test_unspecified_content_still_calls_the_adapter(
    adapter_class, step, role, omit_content
):
    adapter = adapter_class()
    result = await scenario.run(
        name="generated content",
        description="Only unspecified content requests generation",
        agents=[adapter],
        script=[step() if omit_content else step(None), scenario.succeed()],
        verbose=False,
    )

    assert result.success
    assert result.messages[-1]["role"] == role
    assert result.messages[-1].get("content") == "generated"
    assert len(adapter.inputs) == 1


@pytest.mark.asyncio
async def test_an_empty_scripted_user_message_reaches_the_agent_unchanged():
    user, agent = RecordingUser(), RecordingAgent()
    result = await scenario.run(
        name="empty user input",
        description="The agent receives the scripted empty user message",
        agents=[user, agent],
        script=[scenario.user(""), scenario.agent(), scenario.succeed()],
        verbose=False,
    )

    assert result.success
    assert user.inputs == []
    assert len(agent.inputs) == 1
    assert [message["content"] for message in agent.inputs[0].new_messages] == [""]
