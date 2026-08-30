"""
``scenario.run`` accepts the object ``langwatch.connect_agent`` returns.

Covers ``specs/connected-agent-adapter.feature``. The decorated object is
replaced by a fake with the same duck-typed shape: callable, a ``name`` and
an awaitable ``invoke``. No network and no LangWatch connection is needed.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, cast

import pytest

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.connected_agent import (
    ConnectedAgentAdapter,
    ConnectedAgentCall,
    is_connected_agent,
    read_reply,
    resolve_agents,
)
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import AgentInput, AgentRole


@dataclass
class FakeReply:
    """The SDK's ``AgentReply``: an output and a session."""

    output: Any
    session: Any = None


class FakeConnectedAgent:
    """The shape ``langwatch.connect_agent`` returns.

    ``invoke`` records every call it receives and answers with the reply
    the test queued, or with a string that names the turn.
    """

    def __init__(self, name: str = "support-agent", model: str = "gpt-5-mini"):
        self.name = name
        self.environment = "development"
        self.default_model = model
        self.calls: List[ConnectedAgentCall] = []
        self.replies: List[Any] = []

    def __call__(self, messages: List[Any], model: Optional[str] = None) -> str:
        return f"direct:{model or self.default_model}"

    async def invoke(self, call: ConnectedAgentCall) -> Any:
        self.calls.append(call)
        if self.replies:
            return self.replies.pop(0)
        return f"turn {len(self.calls)}"


def make_input(
    thread_id: str = "thread-1",
    messages: Optional[List[Any]] = None,
    new_messages: Optional[List[Any]] = None,
    propagation_headers: Optional[Dict[str, str]] = None,
) -> AgentInput:
    messages = messages if messages is not None else [
        {"role": "user", "content": "hello"}
    ]
    return AgentInput(
        thread_id=thread_id,
        messages=messages,
        new_messages=new_messages if new_messages is not None else messages,
        judgment_request=None,
        scenario_state=cast(Any, None),
        propagation_headers=propagation_headers or {},
    )


class PlainAdapter(AgentAdapter):
    async def call(self, input: AgentInput) -> str:
        return "plain"


class ScriptedUser(AgentAdapter):
    """Holds the USER role; every user turn of the script carries its own text."""

    role = AgentRole.USER

    async def call(self, input: AgentInput) -> str:
        raise AssertionError("the script supplies every user message")


class TestAccept:
    """Scenario: The decorated function is accepted as an agent without an adapter subclass."""

    def test_wraps_the_decorated_function_and_keeps_adapters(self):
        fake = FakeConnectedAgent()
        plain = PlainAdapter()

        resolved = resolve_agents([fake, plain])

        assert isinstance(resolved[0], ConnectedAgentAdapter)
        assert resolved[0].role == AgentRole.AGENT
        assert resolved[0].name == "support-agent"
        assert resolved[1] is plain

    def test_only_a_callable_with_name_and_invoke_is_connected(self):
        assert is_connected_agent(FakeConnectedAgent())
        assert not is_connected_agent(PlainAdapter())
        assert not is_connected_agent(lambda messages: "hi")
        assert not is_connected_agent("support-agent")

    def test_the_decorated_function_stays_directly_callable(self):
        fake = FakeConnectedAgent()
        resolve_agents([fake])

        assert fake([{"role": "user", "content": "hi"}]) == "direct:gpt-5-mini"

    def test_the_executor_accepts_the_decorated_function(self):
        fake = FakeConnectedAgent()

        executor = ScenarioExecutor(
            name="accept",
            description="a connected agent function in the agents list",
            agents=[fake, scenario.JudgeAgent(criteria=["any"], model="openai/gpt-5-mini")],
            parameters={"model": "gpt-5-mini"},
        )

        assert isinstance(executor.agents[0], ConnectedAgentAdapter)
        assert executor.agents[0].parameters == {"model": "gpt-5-mini"}
        assert isinstance(executor.agents[1], scenario.JudgeAgent)


class TestConnectedCall:
    """Scenario: The wrapper builds the connected call from the scenario input."""

    @pytest.mark.asyncio
    async def test_the_function_receives_the_turn_fields(self):
        fake = FakeConnectedAgent()
        adapter = ConnectedAgentAdapter(fake)
        messages = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"},
        ]
        trace_id = "0af7651916cd43dd8448eb211c80319c"

        await adapter.call(
            make_input(
                thread_id="thread-7",
                messages=messages,
                new_messages=messages[2:],
                propagation_headers={
                    "traceparent": f"00-{trace_id}-b7ad6b7169203331-01"
                },
            )
        )

        call = fake.calls[0]
        assert call.messages == messages
        assert call.new_messages == messages[2:]
        assert call.thread_id == "thread-7"
        assert call.trace_id == trace_id
        assert call.session is None
        assert call.turn_fields()["thread_id"] == "thread-7"

    @pytest.mark.asyncio
    async def test_no_trace_context_means_no_trace_id(self):
        fake = FakeConnectedAgent()
        adapter = ConnectedAgentAdapter(fake)

        await adapter.call(make_input())

        assert fake.calls[0].trace_id is None


class TestReplyShapes:
    """Scenarios: string, single message, list of messages, output with session."""

    @pytest.mark.asyncio
    async def test_a_string_reply(self):
        fake = FakeConnectedAgent()
        fake.replies = ["hello there"]

        assert await ConnectedAgentAdapter(fake).call(make_input()) == "hello there"

    @pytest.mark.asyncio
    async def test_a_single_message_reply(self):
        fake = FakeConnectedAgent()
        message = {"role": "assistant", "content": "one message"}
        fake.replies = [message]

        assert await ConnectedAgentAdapter(fake).call(make_input()) == message

    @pytest.mark.asyncio
    async def test_a_list_of_messages_reply(self):
        fake = FakeConnectedAgent()
        messages = [
            {"role": "assistant", "content": "step one"},
            {"role": "assistant", "content": "step two"},
        ]
        fake.replies = [messages]

        assert await ConnectedAgentAdapter(fake).call(make_input()) == messages

    @pytest.mark.asyncio
    async def test_an_output_with_session_reply_is_unwrapped(self):
        fake = FakeConnectedAgent()
        fake.replies = [FakeReply(output="wrapped", session={"cursor": 1})]

        assert await ConnectedAgentAdapter(fake).call(make_input()) == "wrapped"

    @pytest.mark.asyncio
    async def test_a_mapping_with_output_and_session_is_unwrapped(self):
        fake = FakeConnectedAgent()
        fake.replies = [{"output": "from a dict", "session": "s-1"}]
        adapter = ConnectedAgentAdapter(fake)

        assert await adapter.call(make_input()) == "from a dict"
        assert adapter.session_for("thread-1") == "s-1"

    def test_read_reply_coerces_none_and_scalars(self):
        assert read_reply(None) == ("", None)
        assert read_reply(42) == ("42", None)
        assert read_reply(FakeReply(output=None, session="s")) == ("", "s")


class TestSessionEcho:
    """Scenarios: the session round trip across turns and threads."""

    @pytest.mark.asyncio
    async def test_the_session_arrives_on_the_next_turn_of_the_same_thread(self):
        fake = FakeConnectedAgent()
        fake.replies = [FakeReply(output="first", session={"conversation": "abc"})]
        adapter = ConnectedAgentAdapter(fake)

        await adapter.call(make_input(thread_id="thread-a"))
        await adapter.call(make_input(thread_id="thread-a"))
        await adapter.call(make_input(thread_id="thread-b"))

        assert fake.calls[0].session is None
        assert fake.calls[1].session == {"conversation": "abc"}
        assert fake.calls[2].session is None

    @pytest.mark.asyncio
    async def test_a_reply_without_a_session_keeps_the_session_of_the_thread(self):
        fake = FakeConnectedAgent()
        fake.replies = [FakeReply(output="first", session="s-1"), "plain second"]
        adapter = ConnectedAgentAdapter(fake)

        await adapter.call(make_input())
        await adapter.call(make_input())
        await adapter.call(make_input())

        assert fake.calls[2].session == "s-1"

    @pytest.mark.asyncio
    async def test_a_new_session_replaces_the_old_one(self):
        fake = FakeConnectedAgent()
        fake.replies = [
            FakeReply(output="first", session="s-1"),
            FakeReply(output="second", session="s-2"),
        ]
        adapter = ConnectedAgentAdapter(fake)

        await adapter.call(make_input())
        await adapter.call(make_input())
        await adapter.call(make_input())

        assert fake.calls[2].session == "s-2"


class TestRunParameters:
    """Scenarios: run parameters reach the function, or the function default applies."""

    @pytest.mark.asyncio
    async def test_parameters_from_the_scenario_reach_the_function(self):
        fake = FakeConnectedAgent()
        adapter = ConnectedAgentAdapter(fake, parameters={"model": "gpt-5-mini"})

        await adapter.call(make_input())

        assert fake.calls[0].parameters == {"model": "gpt-5-mini"}

    @pytest.mark.asyncio
    async def test_no_parameters_means_the_function_default_applies(self):
        fake = FakeConnectedAgent()
        adapter = ConnectedAgentAdapter(fake)

        await adapter.call(make_input())

        assert fake.calls[0].parameters == {}

    @pytest.mark.asyncio
    async def test_each_call_gets_its_own_copy_of_the_parameters(self):
        fake = FakeConnectedAgent()
        adapter = ConnectedAgentAdapter(fake, parameters={"model": "gpt-5-mini"})

        await adapter.call(make_input())
        fake.calls[0].parameters["model"] = "changed by the function"
        await adapter.call(make_input())

        assert fake.calls[1].parameters == {"model": "gpt-5-mini"}


class TestEndToEnd:
    """A scripted scenario runs the decorated function through ``scenario.arun``."""

    @pytest.mark.asyncio
    async def test_a_multi_turn_scenario_echoes_the_session(self):
        fake = FakeConnectedAgent()
        fake.replies = [
            FakeReply(output="how can I help?", session={"ticket": 1}),
            FakeReply(output="done", session={"ticket": 2}),
        ]

        result = await scenario.arun(
            name="connected agent",
            description="the user asks for help twice",
            agents=[fake, ScriptedUser()],
            parameters={"model": "gpt-5-mini"},
            script=[
                scenario.user("I need help"),
                scenario.agent(),
                scenario.user("one more thing"),
                scenario.agent(),
                scenario.succeed(),
            ],
        )

        assert result.success
        assert [call.session for call in fake.calls] == [None, {"ticket": 1}]
        assert fake.calls[1].parameters == {"model": "gpt-5-mini"}
        assert len(fake.calls[1].messages) == 3
        assert [m["role"] for m in fake.calls[1].new_messages] == ["user"]
        assert fake.calls[1].messages[1]["content"] == "how can I help?"
