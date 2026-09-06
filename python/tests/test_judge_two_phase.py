"""
Two-phase judge: decision gate then verdict.

Binds the @unit scenarios of specs/judge-two-phase.feature that concern the
call flow and the tool shapes. The #886 inconclusive scenarios are bound in
tests/test_judge_inconclusive_continues.py, the min_turns floor in
tests/test_judge_min_turns.py, and decision-discovery exhaustion in
tests/test_judge_discovery_exhaustion.py.
"""

import json
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from scenario import JudgeAgent
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest, ScenarioResult


CRITERIA = ["Agent answers the question"]
CRITERION_KEY = "agent_answers_the_question"

EMPTY_PARAMETERS = {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": False,
}


def _tool_response(name: str, arguments: Optional[dict] = None) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = name
    response.choices[0].message.tool_calls[0].function.arguments = json.dumps(
        arguments or {}
    )
    return response


def _finish_response(verdict: str = "success") -> MagicMock:
    return _tool_response(
        "finish_test",
        {
            "criteria": {CRITERION_KEY: "true" if verdict == "success" else "false"},
            "reasoning": "Verdict delivered.",
            "verdict": verdict,
        },
    )


def _agent_input(
    *,
    current_turn: int = 1,
    max_turns: int = 10,
    judgment_request: Optional[JudgmentRequest] = None,
) -> AgentInput:
    mock_state = MagicMock()
    mock_state.description = "Test scenario"
    mock_state.current_turn = current_turn
    mock_state.config.max_turns = max_turns
    mock_state.config.min_turns = None
    return AgentInput(
        thread_id="two-phase-thread",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=mock_state,
    )


async def _call_judge(
    *,
    responses: List[MagicMock],
    agent_input: AgentInput,
) -> "tuple[Any, List[Dict[str, Any]]]":
    """Run one JudgeAgent.call with scripted responses; returns
    (result, kwargs of every completion call)."""
    previous_default_config = ScenarioConfig.default_config
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-5-mini")
    judge = JudgeAgent(criteria=CRITERIA)

    calls: List[Dict[str, Any]] = []
    queue = list(responses)

    def fake_completion(**kwargs: Any) -> MagicMock:
        calls.append(kwargs)
        return queue.pop(0) if len(queue) > 1 else queue[0]

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


def _offered_tools(call_kwargs: Dict[str, Any]) -> List[dict]:
    return list(call_kwargs.get("tools", []))


def _tool_names(call_kwargs: Dict[str, Any]) -> List[str]:
    return [tool["function"]["name"] for tool in _offered_tools(call_kwargs)]


@pytest.mark.asyncio
async def test_mid_conversation_call_decides_with_argument_free_tools():
    """@scenario A mid-conversation judge call decides between continuing and judging with argument-free tools"""
    result, calls = await _call_judge(
        responses=[_tool_response("continue_test")],
        agent_input=_agent_input(current_turn=1),
    )

    assert result == []
    assert len(calls) == 1
    assert _tool_names(calls[0]) == ["continue_test", "make_verdict"]
    for tool in _offered_tools(calls[0]):
        assert tool["function"]["parameters"] == EMPTY_PARAMETERS, (
            "decision tools carry no arguments: no reasoning field, no "
            "verdict schema"
        )


@pytest.mark.asyncio
async def test_make_verdict_leads_to_exactly_one_verdict_call():
    """@scenario A make_verdict decision leads to exactly one verdict call"""
    result, calls = await _call_judge(
        responses=[_tool_response("make_verdict"), _finish_response("success")],
        agent_input=_agent_input(current_turn=1),
    )

    assert len(calls) == 2
    assert calls[1]["tool_choice"] == {
        "type": "function",
        "function": {"name": "finish_test"},
    }
    assert isinstance(result, ScenarioResult)
    assert result.success is True
    assert result.reasoning == "Verdict delivered."


@pytest.mark.asyncio
async def test_continue_decision_makes_no_verdict_call():
    """@scenario A continue decision makes no verdict call"""
    result, calls = await _call_judge(
        responses=[_tool_response("continue_test")],
        agent_input=_agent_input(current_turn=1),
    )

    assert result == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_explicit_judgment_request_goes_straight_to_the_verdict_call():
    """@scenario An explicit judgment request goes straight to the verdict call"""
    result, calls = await _call_judge(
        responses=[_finish_response("failure")],
        agent_input=_agent_input(
            current_turn=1, judgment_request=JudgmentRequest()
        ),
    )

    assert len(calls) == 1
    names = _tool_names(calls[0])
    assert names == ["finish_test"], "finish_test is the only terminal tool offered"
    assert calls[0]["tool_choice"] == {
        "type": "function",
        "function": {"name": "finish_test"},
    }
    assert isinstance(result, ScenarioResult)


@pytest.mark.asyncio
async def test_last_turn_goes_straight_to_the_verdict_call():
    """@scenario The last turn goes straight to the verdict call"""
    result, calls = await _call_judge(
        responses=[_finish_response("success")],
        agent_input=_agent_input(current_turn=9, max_turns=10),
    )

    assert len(calls) == 1
    assert calls[0]["tool_choice"] == {
        "type": "function",
        "function": {"name": "finish_test"},
    }
    assert isinstance(result, ScenarioResult)


@pytest.mark.asyncio
async def test_decision_prompt_defers_judgment_and_leans_towards_continuing():
    """@scenario The decision prompt defers judgment and leans towards continuing"""
    _, calls = await _call_judge(
        responses=[_tool_response("continue_test")],
        agent_input=_agent_input(current_turn=1),
    )

    system_content = calls[0]["messages"][0]["content"]
    assert "Do not decide whether the criteria pass or fail now" in system_content
    assert (
        "while the conversation is still short, lean towards continuing"
        in system_content
    )
