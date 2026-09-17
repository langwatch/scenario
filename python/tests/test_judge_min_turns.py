"""min_turns judge floor (ADR-005, issue #899).

Below the floor an UNFORCED judge call may not volunteer a verdict. With the
two-phase judge the floor is enforced before any LLM call: the decision
between continuing and judging is predetermined (the conversation must
continue), so the judge returns continue without spending a completion.
Forced judgments (an explicit judgment_request, the last turn) always keep
their terminal contract.

The judge observes a 0-based current_turn (reset() overrides the initial
_new_turn() back to 0, so the call on turn N sees current_turn N-1): with
min_turns=4 the floor holds through the turn-4 call (current_turn 3) and the
first decision call happens on the turn-5 call (current_turn 4). Tests pin
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
) -> tuple[Any, List[Dict[str, Any]]]:
    """Run one JudgeAgent.call and return (result, kwargs of every completion)."""
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

    calls: List[Dict[str, Any]] = []

    def fake_completion(**kwargs: Any) -> ModelResponse:
        calls.append(kwargs)
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

    return result, calls


def _offered_tools(call_kwargs: Dict[str, Any]) -> List[str]:
    return [tool["function"]["name"] for tool in call_kwargs.get("tools", [])]


class TestGatedUnforcedCall:
    @pytest.mark.asyncio
    async def test_continues_without_any_llm_call(self):
        """@scenario Below the min_turns floor the judge continues without any LLM call"""
        result, calls = await _call_judge(current_turn=1, min_turns=4)

        assert result == []
        assert calls == []

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_changes_nothing_below_the_floor(self):
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

        mock_executor = MagicMock()
        mock_executor.config = MagicMock()
        mock_executor.config.cache_key = None
        token = context_scenario.set(mock_executor)
        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                side_effect=AssertionError("no LLM call below the floor"),
            ):
                result = await judge.call(agent_input)
        finally:
            context_scenario.reset(token)
            ScenarioConfig.default_config = previous_default_config

        assert result == []


class TestForcedJudgmentsAreNeverGated:
    @pytest.mark.asyncio
    async def test_judgment_request_below_floor_stays_terminal(self):
        result, calls = await _call_judge(
            current_turn=0,
            min_turns=4,
            judgment_request=JudgmentRequest(),
            respond_with=_finish_response("failure"),
        )

        assert len(calls) == 1
        assert "finish_test" in _offered_tools(calls[0])
        assert calls[0]["tool_choice"] == {
            "type": "function",
            "function": {"name": "finish_test"},
        }
        assert result.success is False

    @pytest.mark.asyncio
    async def test_last_turn_at_the_floor_stays_terminal(self):
        # max_turns 5 -> current_turn 4 (the turn-5 call) is the last-message
        # call. min_turns 5 would otherwise gate it; forced wins.
        result, calls = await _call_judge(
            current_turn=4,
            min_turns=5,
            max_turns=5,
            respond_with=_finish_response("success"),
        )

        assert len(calls) == 1
        assert "finish_test" in _offered_tools(calls[0])
        assert result.success is True


class TestUnsetMinTurnsMakesTheDecisionCall:
    @pytest.mark.asyncio
    async def test_decision_tools_offered_from_the_first_turn(self):
        result, calls = await _call_judge(current_turn=0, min_turns=None)

        assert len(calls) == 1
        assert _offered_tools(calls[0]) == ["continue_test", "make_verdict"]
        assert calls[0]["tool_choice"] == "required"
        assert result == []


class TestTurnSequence:
    @pytest.mark.asyncio
    async def test_decision_call_first_made_on_the_turn_5_call(self):
        # The call on turn N observes current_turn N-1, so turns 1..6 are
        # current_turn 0..5.
        llm_called_by_current_turn = {}
        for current_turn in range(6):
            _, calls = await _call_judge(
                current_turn=current_turn, min_turns=4
            )
            llm_called_by_current_turn[current_turn] = len(calls) > 0

        assert llm_called_by_current_turn == {
            0: False,  # turn 1
            1: False,  # turn 2
            2: False,  # turn 3
            3: False,  # turn 4
            4: True,  # turn 5: the floor of 4 turns has passed
            5: True,  # turn 6
        }


class TestGatedLargeTranscript:
    @pytest.mark.asyncio
    async def test_below_the_floor_even_a_large_transcript_makes_no_llm_call(self):
        """The floor check runs before the decision phase, so a transcript
        that would otherwise route into the discovery loop still costs zero
        completions below the floor."""
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
        # A tiny token_threshold trips is_large_transcript on any transcript.
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

        mock_executor = MagicMock()
        mock_executor.config = MagicMock()
        mock_executor.config.cache_key = None
        token = context_scenario.set(mock_executor)
        try:
            with patch(
                "scenario.judge_agent.litellm.completion",
                side_effect=AssertionError("no LLM call below the floor"),
            ):
                result = await judge.call(agent_input)
        finally:
            context_scenario.reset(token)
            ScenarioConfig.default_config = previous_default_config

        assert result == []


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
        it moves towards the verdict the moment the tools allow it. With
        min_turns=2 the first LLM calls land on the turn-3 judge call: one
        decision (make_verdict) and one verdict (finish_test)."""
        previous_default_config = ScenarioConfig.default_config
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

        agent = _EchoAgent()
        user = _CountingUser()
        judge = JudgeAgent(criteria=CRITERIA)

        offered_by_call: List[List[str]] = []

        def fake_completion(**kwargs: Any) -> ModelResponse:
            offered = [tool["function"]["name"] for tool in kwargs.get("tools", [])]
            offered_by_call.append(offered)
            if "finish_test" in offered:
                return _finish_response("success")
            if "make_verdict" in offered:
                return _tool_call_response("make_verdict", {})
            return _continue_response()

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

        # Turns 1 and 2 are gated without an LLM call (judge observes 0-based
        # current_turn), so the first calls land on the turn-3 judge call: the
        # decision, then the verdict.
        assert offered_by_call == [
            ["continue_test", "make_verdict"],
            ["finish_test"],
        ]
        assert user.calls == 3
        assert result.success is True
