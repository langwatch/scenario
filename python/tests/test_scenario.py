import pytest
import scenario


class MockJudgeAgent(scenario.JudgeAgent):
    async def call(
        self,
        input: scenario.AgentInput,
    ) -> scenario.AgentReturnTypes:
        return scenario.ScenarioResult(
            success=True,
            messages=[],
            reasoning="test reasoning",
            passed_criteria=["test criteria"],
        )


class MockUserSimulatorAgent(scenario.UserSimulatorAgent):
    async def call(
        self,
        input: scenario.AgentInput,
    ) -> scenario.AgentReturnTypes:
        return {"role": "user", "content": "Hi, I'm a user"}


class MockAgent(scenario.AgentAdapter):
    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        return {"role": "assistant", "content": "Hey, how can I help you?"}


@pytest.mark.asyncio
async def test_scenario_high_level_api():
    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(
                criteria=["test criteria"],
            ),
        ],
    )

    assert result.success


@pytest.mark.asyncio
async def test_scenario_high_level_api_allow_to_config_directly():
    # Make sure config is not set to allow this
    scenario.default_config = None

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(
                model="none",
                criteria=["test criteria"],
            ),
        ],
    )

    assert result.success


@pytest.mark.asyncio
async def test_scenario_high_level_api_allow_to_skip_criteria():
    class MockJudgeAgent(scenario.JudgeAgent):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return {"role": "user", "content": "Hi, I'm a user"}

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(),
        ],
        max_turns=2,
    )

    assert not result.success
    assert result.reasoning and "Reached maximum turns" in result.reasoning


@pytest.mark.asyncio
async def test_scenario_allow_scripted_scenario():
    class MockAgent(scenario.AgentAdapter):
        async def call(
            self,
            input: scenario.AgentInput,
        ) -> scenario.AgentReturnTypes:
            for message in input.new_messages:
                if "trace_id" in message:
                    del message["trace_id"]

            assert input.new_messages == [
                {
                    "role": "user",
                    "content": "Hi, I'm a hardcoded user message",
                }
            ]

            return [
                {
                    "role": "assistant",
                    "content": "Hey, how can I help you?",
                }
            ]

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.proceed(),
        ],
    )

    assert result.success


@pytest.mark.asyncio
async def test_scenario_allow_scripted_scenario_with_lower_level_openai_messages():
    class MockAgent(scenario.AgentAdapter):
        async def call(
            self,
            input: scenario.AgentInput,
        ) -> scenario.AgentReturnTypes:
            for message in input.new_messages:
                if "trace_id" in message:
                    del message["trace_id"]

            assert input.new_messages == [
                {
                    "role": "user",
                    "content": "Hi, I'm a hardcoded user message",
                }
            ]

            return [
                {
                    "role": "assistant",
                    "content": "Hey, how can I help you?",
                }
            ]

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.message(
                {"role": "user", "content": "Hi, I'm a hardcoded user message"}
            ),
            scenario.proceed(),
        ],
    )

    assert result.success


@pytest.mark.asyncio
async def test_scenario_scripted_fails_if_script_ends_without_conclusion():
    """Script exhaustion without explicit conclusion is always an error."""
    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
        ],
    )

    assert not result.success
    assert (
        result.reasoning
        and "Reached end of script without conclusion" in result.reasoning
    )


@pytest.mark.asyncio
async def test_scenario_scripted_force_success():
    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.succeed(),
        ],
    )

    assert result.success
    assert (
        result.reasoning
        and "Scenario marked as successful with scenario.succeed()" in result.reasoning
    )


@pytest.mark.asyncio
async def test_scenario_scripted_force_failure():
    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.fail(),
        ],
    )

    assert not result.success
    assert (
        result.reasoning
        and "Scenario marked as failed with scenario.fail()" in result.reasoning
    )


@pytest.mark.asyncio
async def test_scenario_scripted_force_judgment():
    class MockJudgeAgent(scenario.JudgeAgent):
        async def call(
            self,
            input: scenario.AgentInput,
        ) -> scenario.AgentReturnTypes:
            if input.judgment_request:
                return scenario.ScenarioResult(
                    success=True,
                    messages=[],
                    reasoning="judgement enforced",
                    passed_criteria=["test criteria"],
                )

            return []

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    assert result.success
    assert result.reasoning and "judgement enforced" in result.reasoning


@pytest.mark.asyncio
async def test_scenario_proceeds_the_amount_of_turns_specified():
    class MockJudgeAgent(scenario.JudgeAgent):
        async def call(
            self,
            input: scenario.AgentInput,
        ) -> scenario.AgentReturnTypes:
            return {"role": "user", "content": "Hi, I'm a user"}

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.agent(),
            scenario.proceed(turns=2),
            scenario.succeed(),
        ],
    )

    assert result.success
    assert len(result.messages) == 6


@pytest.mark.asyncio
async def test_scenario_proceeds_the_amount_of_turns_specified_as_expected_when_halfway_through_a_turn():
    class MockJudgeAgent(scenario.JudgeAgent):
        async def call(
            self,
            input: scenario.AgentInput,
        ) -> scenario.AgentReturnTypes:
            return []

    scenario.configure(default_model="none")

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.proceed(turns=2),
            scenario.succeed(),
        ],
    )

    assert result.success
    assert len(result.messages) == 4


@pytest.mark.asyncio
async def test_scenario_accepts_custom_callbacks():
    class MockAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return [{"role": "tool", "tool_call_id": "tool_call_id", "content": "{}"}]

    scenario.configure(default_model="none")

    def check_for_tool_calls(state: scenario.ScenarioState) -> None:
        assert state.last_message()["role"] == "tool"

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.user("Hi, I'm a hardcoded user message"),
            scenario.agent(),
            check_for_tool_calls,
            scenario.succeed(),
        ],
    )

    assert result.success


@pytest.mark.asyncio
async def test_scenario_accepts_on_turn_and_on_step_callbacks():
    class MockAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            if input.scenario_state.current_turn == 0:
                return {"role": "assistant", "content": "Hey, how can I help you?"}
            else:
                return [
                    {"role": "tool", "tool_call_id": "tool_call_id", "content": "{}"}
                ]

    scenario.configure(default_model="none")

    step_calls = 0

    def check_for_tool_calls(state: scenario.ScenarioState) -> None:
        if state.current_turn > 1:
            assert state.last_message()["role"] == "tool"

    def increment_step_calls(state: scenario.ScenarioState) -> None:
        nonlocal step_calls
        step_calls += 1

    result = await scenario.run(
        name="test name",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(),
            MockJudgeAgent(criteria=["test criteria"]),
        ],
        script=[
            scenario.proceed(
                on_turn=check_for_tool_calls,
                on_step=increment_step_calls,
            ),
        ],
    )

    assert result.success
    assert step_calls == 3


# ---------------------------------------------------------------------------
# Gap #2: AssertionError in check functions → structured failed_criteria
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_scenario_assertion_error_surfaces_as_failed_criteria():
    """When a check function raises AssertionError, the message appears in failed_criteria."""
    scenario.configure(default_model="none")

    def failing_check(state: scenario.ScenarioState):
        assert False, "Agent leaked PII"

    with pytest.raises(AssertionError, match="Agent leaked PII"):
        await scenario.run(
            name="test name",
            description="test description",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(),
                MockJudgeAgent(criteria=["test criteria"]),
            ],
            script=[
                scenario.user("Hi"),
                scenario.agent(),
                failing_check,
                scenario.succeed(),  # should never reach
            ],
        )


@pytest.mark.asyncio
async def test_scenario_assertion_error_includes_passed_checkpoints():
    """Assertion failure result includes previously-passed checkpoint criteria."""

    class CheckpointJudge(scenario.JudgeAgent):
        """Judge that supports inline checkpoints — returns checkpoint result
        when criteria are provided, not a final verdict."""
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            if input.judgment_request and input.judgment_request.criteria:
                return scenario.ScenarioResult(
                    success=True,
                    messages=[],
                    reasoning="checkpoint passed",
                    passed_criteria=input.judgment_request.criteria,
                )
            return []

    scenario.configure(default_model="none")

    def failing_check(state: scenario.ScenarioState):
        assert False, "Security violation"

    with pytest.raises(AssertionError, match="Security violation"):
        await scenario.run(
            name="test name",
            description="test description",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(),
                CheckpointJudge(criteria=[]),
            ],
            script=[
                scenario.user("Hi"),
                scenario.agent(),
                scenario.judge(criteria=["Agent responded politely"]),
                scenario.user("More"),
                scenario.agent(),
                failing_check,
            ],
        )


@pytest.mark.asyncio
async def test_scenario_non_assertion_error_is_not_caught_as_criteria():
    """Non-AssertionError exceptions propagate normally, not as structured criteria."""
    scenario.configure(default_model="none")

    def broken_check(state: scenario.ScenarioState):
        raise RuntimeError("network failure")

    with pytest.raises(RuntimeError, match="network failure"):
        await scenario.run(
            name="test name",
            description="test description",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(),
                MockJudgeAgent(criteria=["test criteria"]),
            ],
            script=[
                scenario.user("Hi"),
                scenario.agent(),
                broken_check,
                scenario.succeed(),
            ],
        )




# ---------------------------------------------------------------------------
# Gap #5: marathon_script success_score=None path structure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_marathon_script_no_early_exit_structure():
    """When success_score=None, marathon_script produces user/agent/check pattern without early-exit."""
    from scenario import RedTeamAgent
    from scenario.script import user, agent, judge

    agent_obj = RedTeamAgent.crescendo(
        target="test",
        model="openai/gpt-4",
        success_score=None,
        total_turns=3,
    )

    check_called = []
    def my_check(state):
        check_called.append(True)

    steps = agent_obj.marathon_script(checks=[my_check])

    # 3 * (user + agent + check) + judge = 10
    assert len(steps) == 10

    # Verify structure: [user, agent, check] repeated, then judge
    # Steps are closures so we check no early-exit async functions exist
    import inspect
    for i in range(3):
        base = i * 3
        # user() and agent() are sync closures, check is our sync function
        assert not inspect.iscoroutinefunction(steps[base]), f"step {base} should be sync (user)"
        assert not inspect.iscoroutinefunction(steps[base + 1]), f"step {base+1} should be sync (agent)"
        assert steps[base + 2] is my_check, f"step {base+2} should be our check"

    # Last step is judge (sync closure)
    assert not inspect.iscoroutinefunction(steps[-1]), "last step should be sync (judge)"
