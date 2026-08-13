"""min_turns judge floor (ADR-005, issue #899).

Below the floor an UNFORCED judge call may not volunteer a verdict —
finish_test is withheld from its tool set entirely. Forced judgments (an
explicit judgment_request, the last turn) always keep their terminal
contract, and a gated large-trace call whose discovery loop exhausts
resolves to continue instead of forcing a verdict against a tool set that
does not contain finish_test.

The judge observes a 0-based current_turn (reset() overrides the initial
_new_turn() back to 0, so the call on turn N sees current_turn N-1): with
min_turns=4 the floor holds through the turn-4 call (current_turn 3) and
finish_test is first offered on the turn-5 call (current_turn 4). Tests pin
that observable sequence, plus an end-to-end run where an eager judge is
held open until the floor has passed.
"""

import json
import os
from typing import Any, ClassVar, Dict, List, Optional
from unittest.mock import patch, MagicMock

import pytest
from litellm import ModelResponse

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario import JudgeAgent
from scenario.agent_adapter import AgentAdapter
from scenario.config import ScenarioConfig
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, JudgmentRequest
from scenario.cache import context_scenario

GATED_PROMPT_LINE = "ending the test is not available on this turn"

CRITERIA = ["Agent greets the user politely"]
CRITERION_KEY = "agent_greets_the_user_politely"


def _tool_call_response(name: str, arguments: dict[str, Any]) -> ModelResponse:
    # A real ModelResponse, not a MagicMock: full runs serialize the LLM
    # response into tracing spans, and a MagicMock hangs the JSON encoder.
    return ModelResponse(
        choices=[
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "tc-1",
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    )


def _continue_response() -> ModelResponse:
    return _tool_call_response("continue_test", {})


def _finish_response(verdict: str = "success") -> ModelResponse:
    return _tool_call_response(
        "finish_test",
        {
            "criteria": {
                CRITERION_KEY: "true" if verdict == "success" else "false"
            },
            "reasoning": "Verdict reached.",
            "verdict": verdict,
        },
    )


async def _call_judge(
    *,
    current_turn: int,
    min_turns: Optional[int],
    max_turns: int = 10,
    judgment_request: Optional[JudgmentRequest] = None,
    respond_with: Optional[ModelResponse] = None,
) -> tuple[Any, Dict[str, Any]]:
    """Run one JudgeAgent.call and return (result, captured completion kwargs)."""
    previous_default_config = ScenarioConfig.default_config
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    judge = JudgeAgent(criteria=CRITERIA)

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = current_turn
    mock_scenario_state.config.max_turns = max_turns
    mock_scenario_state.config.min_turns = min_turns

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=mock_scenario_state,
    )

    captured: Dict[str, Any] = {}

    def fake_completion(**kwargs: Any) -> ModelResponse:
        captured.update(kwargs)
        return respond_with if respond_with is not None else _continue_response()

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", side_effect=fake_completion
        ):
            result = await judge.call(agent_input)
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = previous_default_config

    return result, captured


def _offered_tools(captured: Dict[str, Any]) -> List[str]:
    return [tool["function"]["name"] for tool in captured.get("tools", [])]


class TestGatedUnforcedCall:
    @pytest.mark.asyncio
    async def test_withholds_finish_test_and_continues(self):
        result, captured = await _call_judge(current_turn=1, min_turns=4)

        assert "continue_test" in _offered_tools(captured)
        assert "finish_test" not in _offered_tools(captured)
        assert captured["tool_choice"] == "required"
        assert result == []

    @pytest.mark.asyncio
    async def test_system_prompt_says_ending_is_unavailable(self):
        _, captured = await _call_judge(current_turn=1, min_turns=4)

        assert GATED_PROMPT_LINE in captured["messages"][0]["content"]

    @pytest.mark.asyncio
    async def test_custom_system_prompt_also_gets_the_gated_line(self):
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
        judge = JudgeAgent(
            criteria=CRITERIA, system_prompt="You are a strict reviewer."
        )

        mock_scenario_state = MagicMock()
        mock_scenario_state.description = "Test scenario"
        mock_scenario_state.current_turn = 0
        mock_scenario_state.config.max_turns = 10
        mock_scenario_state.config.min_turns = 3

        agent_input = AgentInput(
            thread_id="test",
            messages=[{"role": "user", "content": "Hello"}],
            new_messages=[],
            judgment_request=None,
            scenario_state=mock_scenario_state,
        )

        captured: Dict[str, Any] = {}

        def fake_completion(**kwargs: Any) -> ModelResponse:
            captured.update(kwargs)
            return _continue_response()

        mock_executor = MagicMock()
        mock_executor.config = MagicMock()
        mock_executor.config.cache_key = None
        token = context_scenario.set(mock_executor)
        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                side_effect=fake_completion,
            ):
                await judge.call(agent_input)
        finally:
            context_scenario.reset(token)
            ScenarioConfig.default_config = previous_default_config

        system_content = captured["messages"][0]["content"]
        assert "You are a strict reviewer." in system_content
        assert GATED_PROMPT_LINE in system_content


class TestForcedJudgmentsAreNeverGated:
    @pytest.mark.asyncio
    async def test_judgment_request_below_floor_stays_terminal(self):
        result, captured = await _call_judge(
            current_turn=0,
            min_turns=4,
            judgment_request=JudgmentRequest(),
            respond_with=_finish_response("failure"),
        )

        assert "finish_test" in _offered_tools(captured)
        assert captured["tool_choice"] == {
            "type": "function",
            "function": {"name": "finish_test"},
        }
        assert result.success is False

    @pytest.mark.asyncio
    async def test_last_turn_at_the_floor_stays_terminal(self):
        # max_turns 5 → current_turn 4 (the turn-5 call) is the last-message
        # call. min_turns 5 would otherwise gate it — forced wins.
        result, captured = await _call_judge(
            current_turn=4,
            min_turns=5,
            max_turns=5,
            respond_with=_finish_response("success"),
        )

        assert "finish_test" in _offered_tools(captured)
        assert result.success is True


class TestUnsetMinTurnsIsByteIdentical:
    @pytest.mark.asyncio
    async def test_full_tool_set_and_no_gated_prompt_line(self):
        result, captured = await _call_judge(current_turn=0, min_turns=None)

        assert "continue_test" in _offered_tools(captured)
        assert "finish_test" in _offered_tools(captured)
        assert GATED_PROMPT_LINE not in captured["messages"][0]["content"]
        assert result == []


class TestTurnSequence:
    @pytest.mark.asyncio
    async def test_finish_test_first_offered_on_the_turn_5_call(self):
        # The call on turn N observes current_turn N-1, so turns 1..6 are
        # current_turn 0..5.
        offered_by_current_turn = {}
        for current_turn in range(6):
            _, captured = await _call_judge(
                current_turn=current_turn, min_turns=4
            )
            offered_by_current_turn[current_turn] = "finish_test" in _offered_tools(
                captured
            )

        assert offered_by_current_turn == {
            0: False,  # turn 1
            1: False,  # turn 2
            2: False,  # turn 3
            3: False,  # turn 4
            4: True,  # turn 5 — the floor of 4 turns has passed
            5: True,  # turn 6
        }


class TestGatedDiscoveryExhaustion:
    def test_exhaustion_below_the_floor_continues_without_forcing(self):
        """_force_verdict pins tool_choice to finish_test — a tool a gated
        call does not offer. Firing it below the floor would make the provider
        reject the call and kill the run; the gated loop must return continue
        instead (ADR-005, Decision 5)."""
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
        judge = JudgeAgent(criteria=CRITERIA, max_discovery_steps=2)

        discovery_response = _tool_call_response("grep_trace", {"pattern": "x"})

        mock_executor = MagicMock()
        mock_executor.config = MagicMock()
        mock_executor.config.cache_key = None
        token = context_scenario.set(mock_executor)
        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                return_value=discovery_response,
            ), patch.object(
                judge, "_execute_discovery_tool", return_value="tool result"
            ), patch.object(
                judge,
                "_force_verdict",
                side_effect=AssertionError(
                    "_force_verdict must not fire below the min_turns floor"
                ),
            ):
                result = judge._run_discovery_loop(
                    messages=[{"role": "system", "content": "judge"}],
                    tools=[
                        {
                            "type": "function",
                            "function": {
                                "name": "continue_test",
                                "description": "Continue the test",
                                "strict": True,
                                "parameters": {
                                    "type": "object",
                                    "properties": {},
                                    "required": [],
                                    "additionalProperties": False,
                                },
                            },
                        }
                    ],
                    tool_choice="required",
                    spans=[],
                    working_messages=[],
                    effective_criteria=CRITERIA,
                    input_messages=[],
                    verdict_forced=False,
                    verdict_gated=True,
                )
        finally:
            context_scenario.reset(token)
            ScenarioConfig.default_config = previous_default_config

        assert result == []

    @pytest.mark.asyncio
    async def test_gated_exhaustion_through_the_real_call_path(self):
        """Same invariant, but through judge.call() itself: proves call()
        actually wires verdict_gated into the discovery loop. The direct-loop
        test above would stay green even if call() dropped the kwarg."""
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
        # A tiny token_threshold trips is_large_transcript on any transcript,
        # routing call() into the discovery loop.
        judge = JudgeAgent(
            criteria=CRITERIA, max_discovery_steps=2, token_threshold=10
        )

        mock_scenario_state = MagicMock()
        mock_scenario_state.description = "Test scenario"
        mock_scenario_state.current_turn = 1
        mock_scenario_state.config.max_turns = 10
        mock_scenario_state.config.min_turns = 4

        agent_input = AgentInput(
            thread_id="test",
            messages=[{"role": "user", "content": "Hello " * 500}],
            new_messages=[],
            judgment_request=None,
            scenario_state=mock_scenario_state,
        )

        tools_per_call: list[list[str]] = []

        def fake_completion(**kwargs: Any) -> ModelResponse:
            tools_per_call.append(
                [tool["function"]["name"] for tool in kwargs.get("tools", [])]
            )
            return _tool_call_response("grep_transcript", {"pattern": "x"})

        mock_executor = MagicMock()
        mock_executor.config = MagicMock()
        mock_executor.config.cache_key = None
        token = context_scenario.set(mock_executor)
        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                side_effect=fake_completion,
            ), patch.object(
                judge, "_execute_discovery_tool", return_value="tool result"
            ), patch.object(
                judge,
                "_force_verdict",
                side_effect=AssertionError(
                    "_force_verdict fired below the min_turns floor via call()"
                ),
            ):
                result = await judge.call(agent_input)
        finally:
            context_scenario.reset(token)
            ScenarioConfig.default_config = previous_default_config

        assert result == []
        assert len(tools_per_call) == 2
        for offered in tools_per_call:
            assert "finish_test" not in offered


class TestStartupValidation:
    @pytest.mark.parametrize("min_turns", [-1, 1.5, float("nan"), float("inf")])
    def test_min_turns_rejects_values_outside_non_negative_integer_domain(
        self, min_turns: Any
    ):
        with pytest.raises(ValueError, match="min_turns"):
            ScenarioExecutor(
                name="invalid floor domain",
                description="min_turns must be a non-negative integer",
                min_turns=min_turns,
            )

    def test_min_turns_zero_is_allowed(self):
        ScenarioExecutor(
            name="zero floor",
            description="zero disables the floor without omitting it",
            min_turns=0,
        )

    def test_min_turns_above_max_turns_raises(self):
        with pytest.raises(
            ValueError, match=r"min_turns \(6\) cannot exceed max_turns \(5\)"
        ):
            ScenarioExecutor(
                name="invalid floor",
                description="min_turns above max_turns",
                max_turns=5,
                min_turns=6,
            )

    def test_min_turns_validates_against_default_max_turns(self):
        with pytest.raises(
            ValueError, match=r"min_turns \(11\) cannot exceed max_turns \(10\)"
        ):
            ScenarioExecutor(
                name="invalid floor, default max",
                description="min_turns above the default max_turns of 10",
                min_turns=11,
            )

    def test_min_turns_equal_to_max_turns_is_allowed(self):
        ScenarioExecutor(
            name="floor equals ceiling",
            description="min_turns == max_turns is allowed",
            max_turns=5,
            min_turns=5,
        )


class _EchoAgent(AgentAdapter):
    role: ClassVar[AgentRole] = AgentRole.AGENT

    def __init__(self) -> None:
        self.calls: int = 0

    async def call(self, agent_input: AgentInput) -> AgentReturnTypes:
        self.calls += 1
        return {"role": "assistant", "content": f"agent reply {self.calls}"}


class _CountingUser(AgentAdapter):
    role: ClassVar[AgentRole] = AgentRole.USER

    def __init__(self) -> None:
        self.calls: int = 0

    async def call(self, agent_input: AgentInput) -> AgentReturnTypes:
        self.calls += 1
        return f"user turn {self.calls}"


class TestFloorHoldsEndToEnd:
    @pytest.mark.asyncio
    async def test_eager_judge_is_held_open_until_the_floor_passes(self):
        """The judge stub honors the offered tool set the way a real LLM must:
        it volunteers success the moment finish_test is present. With
        min_turns=2 the verdict lands on the turn-3 call."""
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

        agent = _EchoAgent()
        user = _CountingUser()
        judge = JudgeAgent(criteria=CRITERIA)

        finish_offered_by_call: List[bool] = []

        def fake_completion(**kwargs: Any) -> ModelResponse:
            offered = [tool["function"]["name"] for tool in kwargs.get("tools", [])]
            finish_offered = "finish_test" in offered
            finish_offered_by_call.append(finish_offered)
            return (
                _finish_response("success")
                if finish_offered
                else _continue_response()
            )

        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                side_effect=fake_completion,
            ):
                result = await scenario.arun(
                    name="floor holds",
                    description="judge is satisfied on turn 1 but the floor is 2",
                    agents=[agent, user, judge],
                    max_turns=5,
                    min_turns=2,
                )
        finally:
            ScenarioConfig.default_config = previous_default_config

        # Turns 1 and 2 are gated (judge observes 0-based current_turn), so
        # the verdict lands on the turn-3 call: two gated calls, then one
        # terminal.
        assert finish_offered_by_call == [False, False, True]
        assert user.calls == 3
        assert result.success is True
