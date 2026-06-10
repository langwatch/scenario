import logging

import pytest
import scenario
from scenario import JudgeAgent, UserSimulatorAgent
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, JudgmentRequest, ScenarioResult
from scenario.script import user, agent, judge, succeed

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


def remove_trace_ids(executor: ScenarioExecutor):
    for message in executor._state.messages:
        if "trace_id" in message:
            del message["trace_id"]  # type: ignore
    for message in executor._pending_messages.values():
        for msg in message:
            if "trace_id" in msg:
                del msg["trace_id"]


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
    executor.reset()

    assert executor._state.messages == [], "starts with no messages"

    # User
    await executor.step()

    remove_trace_ids(executor)
    assert executor._state.messages == [
        {"role": "user", "content": "Hi, I'm a user"},
    ], "starts with the user message"

    assert executor._state.current_turn == 0, "stays at turn 0 until agent replied"

    # Assistent
    await executor.step()

    remove_trace_ids(executor)
    assert executor._state.messages == [
        {"role": "user", "content": "Hi, I'm a user"},
        {"role": "assistant", "content": "Hey, how can I help you?"},
    ], "adds the assistant message"

    assert executor._state.current_turn == 0, "stays at turn 0 until next step"

    # Judge
    await executor.step()

    remove_trace_ids(executor)
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
                remove_trace_ids(input.scenario_state._executor)
                assert input.new_messages == [
                    {"role": "user", "content": "Hi, I'm a user"}
                ]
                return {"role": "assistant", "content": "Hey, how can I help you?"}
            else:
                remove_trace_ids(input.scenario_state._executor)
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
                remove_trace_ids(input.scenario_state._executor)
                assert input.new_messages == []
                return "Hi, I'm a user"

            if input.scenario_state.current_turn == 1:
                remove_trace_ids(input.scenario_state._executor)
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
    executor.reset()

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
    executor.reset()

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
    executor.reset()

    await executor.agent()
    assert executor._state.current_turn == 0, "current turn should be 0"
    assert executor._pending_roles_on_turn == [
        AgentRole.AGENT,
        AgentRole.JUDGE,
    ], "user should be removed from the first turn already"

    await executor.user()
    assert executor._state.current_turn == 1, "then turn should be incremented already"
    assert executor._pending_roles_on_turn == [
        AgentRole.USER,
        AgentRole.AGENT,
        AgentRole.JUDGE,
    ], "new turn started with all roles back"


# --- Inline criteria tests ---


class InlineCriteriaMockJudgeAgent(JudgeAgent):
    """Judge that evaluates based on self.criteria and returns pass/fail."""

    async def call(self, input: AgentInput) -> scenario.AgentReturnTypes:
        if not input.judgment_request:
            return []
        # Use criteria from input if provided, otherwise use self.criteria
        effective_criteria = (
            input.judgment_request.criteria
            if input.judgment_request and input.judgment_request.criteria is not None
            else self.criteria
        )
        # Simple mock: succeed if criteria list contains "pass", fail if "fail"
        has_fail = any("fail" in c.lower() for c in effective_criteria)
        if has_fail:
            return ScenarioResult(
                success=False,
                messages=[],
                reasoning="Criteria failed",
                passed_criteria=[c for c in effective_criteria if "fail" not in c.lower()],
                failed_criteria=[c for c in effective_criteria if "fail" in c.lower()],
            )
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="All criteria passed",
            passed_criteria=list(effective_criteria),
            failed_criteria=[],
        )


@pytest.mark.asyncio
async def test_inline_criteria_checkpoint_pass_continues():
    """When inline criteria pass, the script should continue past the judge step."""
    call_count = {"agent": 0}

    class CountingAgent(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            call_count["agent"] += 1
            return {"role": "assistant", "content": "response"}

    executor = ScenarioExecutor(
        name="test inline pass",
        description="test",
        agents=[
            CountingAgent(),
            MockUserSimulatorAgent(model="none"),
            InlineCriteriaMockJudgeAgent(model="none"),
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["criterion A passes"]),
            user("follow up"),
            agent(),
            succeed(),
        ],
    )

    result = await executor.run()
    assert result.success, f"Expected success, got: {result.reasoning}"
    assert call_count["agent"] == 2, "Agent should be called twice (before and after checkpoint)"
    assert "criterion A passes" in result.passed_criteria


@pytest.mark.asyncio
async def test_inline_criteria_checkpoint_fail_stops():
    """When inline criteria fail, the scenario should stop immediately."""
    call_count = {"agent": 0}

    class CountingAgent(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            call_count["agent"] += 1
            return {"role": "assistant", "content": "response"}

    executor = ScenarioExecutor(
        name="test inline fail",
        description="test",
        agents=[
            CountingAgent(),
            MockUserSimulatorAgent(model="none"),
            InlineCriteriaMockJudgeAgent(model="none"),
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["this will fail"]),
            user("should not reach"),
            agent(),
            succeed(),
        ],
    )

    result = await executor.run()
    assert not result.success, "Expected failure"
    assert call_count["agent"] == 1, "Agent should only be called once (before the failed checkpoint)"
    assert "this will fail" in result.failed_criteria


@pytest.mark.asyncio
async def test_multiple_inline_checkpoints_accumulate():
    """Multiple passing checkpoints should accumulate passed criteria."""
    executor = ScenarioExecutor(
        name="test accumulate",
        description="test",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            InlineCriteriaMockJudgeAgent(model="none"),
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["criterion A passes"]),
            user("more"),
            agent(),
            judge(criteria=["criterion B passes", "criterion C passes"]),
        ],
    )

    result = await executor.run()
    assert result.success, f"Expected success, got: {result.reasoning}"
    assert "criterion A passes" in result.passed_criteria
    assert "criterion B passes" in result.passed_criteria
    assert "criterion C passes" in result.passed_criteria


@pytest.mark.asyncio
async def test_inline_criteria_end_of_script_succeeds():
    """Script ending after all checkpoints passed should succeed."""
    executor = ScenarioExecutor(
        name="test end of script",
        description="test",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            InlineCriteriaMockJudgeAgent(model="none"),
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["criterion A passes"]),
        ],
    )

    result = await executor.run()
    assert result.success, f"Expected success, got: {result.reasoning}"
    assert "criterion A passes" in result.passed_criteria


@pytest.mark.asyncio
async def test_inline_criteria_restores_original():
    """After an inline judge call, the JudgeAgent's original criteria should be restored."""
    judge_agent = InlineCriteriaMockJudgeAgent(model="none", criteria=["original criterion"])

    executor = ScenarioExecutor(
        name="test restore",
        description="test",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            judge_agent,
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["inline criterion passes"]),
            succeed(),
        ],
    )

    await executor.run()
    assert judge_agent.criteria == ["original criterion"], "Original criteria should be restored"


@pytest.mark.asyncio
async def test_inline_criteria_fail_includes_accumulated():
    """When a checkpoint fails after a previous one passed, accumulated criteria should be included."""
    executor = ScenarioExecutor(
        name="test fail with accumulated",
        description="test",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            InlineCriteriaMockJudgeAgent(model="none"),
        ],
        script=[
            user("hello"),
            agent(),
            judge(criteria=["criterion A passes"]),
            user("more"),
            agent(),
            judge(criteria=["this will fail"]),
        ],
    )

    result = await executor.run()
    assert not result.success, "Expected failure"
    assert "criterion A passes" in result.passed_criteria, "Previously accumulated criteria should be present"
    assert "this will fail" in result.failed_criteria


# --------------------------------------------------------------------- #
# Voice disconnect logging — issue #488                                  #
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_voice_disconnect_logs_adapter_failures(caplog):
    """A voice adapter whose disconnect() raises must produce a WARNING
    record carrying both the adapter name and a traceback, and must not
    propagate the exception out of _voice_disconnect_all.
    """
    from scenario.voice.adapter import VoiceAgentAdapter

    class ExplodingVoiceAdapter(VoiceAgentAdapter):
        async def connect(self) -> None:
            pass
        async def disconnect(self) -> None:
            raise RuntimeError("twilio voice_url restore failed")
        async def send_audio(self, chunk):  # type: ignore[override]
            pass
        async def recv_audio(self, timeout):  # type: ignore[override]
            raise NotImplementedError

    executor = ScenarioExecutor(
        name="voice disconnect logging",
        description="ensure cleanup failures are surfaced via logging",
        agents=[ExplodingVoiceAdapter()],
    )

    with caplog.at_level(logging.WARNING, logger="scenario"):
        await executor._voice_disconnect_all()

    voice_records = [r for r in caplog.records if "disconnect failed" in r.getMessage()]
    assert voice_records, "expected a WARNING log when adapter disconnect raises"
    record = voice_records[0]
    assert record.levelno == logging.WARNING
    assert "ExplodingVoiceAdapter" in record.getMessage()
    assert record.exc_info is not None, "exc_info must be attached so operators see the traceback"
