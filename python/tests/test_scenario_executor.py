import pytest
import scenario
from scenario import JudgeAgent, UserSimulatorAgent
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult

from scenario.scenario_executor import ScenarioExecutor


class MockJudgeAgent(JudgeAgent):
    async def call(
        self,
        input: AgentInput,
    ) -> scenario.AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="test reasoning",
            passed_criteria=["test criteria"],
        )


class MockUserSimulatorAgent(UserSimulatorAgent):
    async def call(
        self,
        input: AgentInput,
    ) -> scenario.AgentReturnTypes:
        return "Hi, I'm a user"


class MockAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "Hey, how can I help you?"}


@pytest.mark.asyncio
async def test_advance_a_step():
    class MockJudgeAgent(JudgeAgent):
        async def call(
            self,
            input: AgentInput,
        ) -> scenario.AgentReturnTypes:
            return []

    executor = ScenarioExecutor(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
    )

    assert executor._state.messages == [], "starts with no messages"

    # User
    await executor.step()

    assert executor._state.messages == [
        {"role": "user", "content": "Hi, I'm a user"},
    ], "starts with the user message"

    assert executor._state.current_turn == 0, "stays at turn 0 until agent replied"

    # Assistent
    await executor.step()

    assert executor._state.messages == [
        {"role": "user", "content": "Hi, I'm a user"},
        {"role": "assistant", "content": "Hey, how can I help you?"},
    ], "adds the assistant message"

    assert executor._state.current_turn == 0, "stays at turn 0 until next step"

    # Judge
    await executor.step()

    assert executor._state.messages == [
        {"role": "user", "content": "Hi, I'm a user"},
        {"role": "assistant", "content": "Hey, how can I help you?"},
    ], "keeps the same messages because no judgment was made"

    assert executor._state.current_turn == 0, "stays at turn 0 until next step"

    # Next user step
    await executor.step()

    assert executor._state.current_turn == 1, "increments turn"


@pytest.mark.asyncio
async def test_sends_the_right_new_messages():
    class MockJudgeAgent(JudgeAgent):
        async def call(
            self,
            input: AgentInput,
        ) -> scenario.AgentReturnTypes:
            if input.scenario_state.current_turn > 1:
                return ScenarioResult(
                    success=True,
                    messages=[],
                    reasoning="test reasoning",
                    passed_criteria=["test criteria"],
                )

            return []

    class MockAgent(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            if input.scenario_state.current_turn == 0:
                assert input.new_messages == [
                    {"role": "user", "content": "Hi, I'm a user"}
                ]
                return {"role": "assistant", "content": "Hey, how can I help you?"}
            else:
                assert input.messages == [
                    {"role": "user", "content": "Hi, I'm a user"},
                    {"role": "assistant", "content": "Hey, how can I help you?"},
                    {"role": "user", "content": "You can help me testing"},
                ]
                assert input.new_messages == [
                    {"role": "user", "content": "You can help me testing"}
                ]
                return {"role": "assistant", "content": "Is it working?"}

    class MockUserSimulatorAgent(UserSimulatorAgent):
        async def call(
            self,
            input: AgentInput,
        ) -> scenario.AgentReturnTypes:
            if input.scenario_state.current_turn == 0:
                assert input.new_messages == []
                return "Hi, I'm a user"

            if input.scenario_state.current_turn == 1:
                assert input.messages == [
                    {"role": "user", "content": "Hi, I'm a user"},
                    {"role": "assistant", "content": "Hey, how can I help you?"},
                ]
                assert input.new_messages == [
                    {"role": "assistant", "content": "Hey, how can I help you?"}
                ]
                return "You can help me testing"

            raise Exception("Should not be called")

    executor = ScenarioExecutor(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
    )

    # Run first turn
    await executor.step()
    await executor.step()

    assert executor._state.current_turn == 0

    # Run a second turn to trigger the new_messages assertion
    await executor.step()
    await executor.step()


@pytest.mark.asyncio
async def test_for_tool_calls():
    executor = ScenarioExecutor(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
    )
    executor.add_message(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "123",
                    "function": {"name": "foo", "arguments": "{}"},
                    "type": "function",
                }
            ],
        }
    )

    assert executor._state.last_tool_call("foo") == {
        "id": "123",
        "function": {"name": "foo", "arguments": "{}"},
        "type": "function",
    }
    assert executor._state.last_tool_call("bar") is None

    assert executor._state.has_tool_call("foo")
    assert not executor._state.has_tool_call("bar")


@pytest.mark.asyncio
async def test_eliminate_pending_roles_in_order_also_on_scripted_scenarios():
    executor = ScenarioExecutor(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
    )
    await executor.agent()
    assert executor._state.current_turn == 0, "current turn should be 0"
    assert executor._pending_roles_on_turn == [
        AgentRole.AGENT,
        AgentRole.JUDGE
    ], "user should be removed from the first turn already"

    await executor.user()
    assert executor._state.current_turn == 1, "then turn should be incremented already"
    assert executor._pending_roles_on_turn == [
        AgentRole.USER,
        AgentRole.AGENT,
        AgentRole.JUDGE,
    ], "new turn started with all roles back"
