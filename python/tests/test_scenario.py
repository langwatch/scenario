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
