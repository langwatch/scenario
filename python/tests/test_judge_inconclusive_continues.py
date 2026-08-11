"""Regression tests for issue #886: an inconclusive finish_test mid-conversation
must continue the conversation, not end the run as failed.

When nothing forces a verdict (continue_test is freely available), a judge that
answers finish_test with verdict "inconclusive" is saying "I can't tell yet".
Treating that as a terminal failure ends the scenario right after the agent's
last message — which, on a platform surface, reads as the simulated user going
silent. A FORCED judgment (last turn, an explicit judgment_request, discovery
exhaustion) keeps its terminal behavior.
"""

import json
from typing import Any, Optional
from unittest.mock import patch, MagicMock

import pytest

from scenario import JudgeAgent
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest, ScenarioResult
from scenario.cache import context_scenario


async def _run_judge(
    *,
    verdict: Optional[str],
    judgment_request: Optional[JudgmentRequest],
    current_turn: int,
    max_turns: int = 10,
) -> Any:
    """Drive JudgeAgent through a finish_test tool call and return the raw result."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    criteria = ["Agent requests approval before applying the change"]
    judge = JudgeAgent(criteria=criteria)

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = current_turn
    mock_scenario_state.config.max_turns = max_turns

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=mock_scenario_state,
    )

    arguments: dict = {
        "reasoning": "Too early to tell - the conversation should continue.",
        "criteria": {
            "agent_requests_approval_before_applying_the_change": "inconclusive"
        },
    }
    if verdict is not None:
        arguments["verdict"] = verdict

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[0].function.arguments = json.dumps(
        arguments
    )

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ):
            return await judge.call(agent_input)
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_unforced_inconclusive_finish_continues_the_conversation():
    """Mid-conversation, no judgment_request: inconclusive means continue."""
    result = await _run_judge(
        verdict="inconclusive",
        judgment_request=None,
        current_turn=1,
    )

    assert result == []  # the judge's continue contract


@pytest.mark.asyncio
async def test_unforced_finish_with_missing_verdict_continues_too():
    """A finish_test without a verdict field defaults to inconclusive - continue."""
    result = await _run_judge(
        verdict=None,
        judgment_request=None,
        current_turn=1,
    )

    assert result == []


@pytest.mark.asyncio
async def test_forced_by_judgment_request_stays_terminal():
    """An explicit judgment_request keeps today's terminal behavior."""
    result = await _run_judge(
        verdict="inconclusive",
        judgment_request=JudgmentRequest(),
        current_turn=1,
    )

    assert isinstance(result, ScenarioResult)
    assert result.success is False


@pytest.mark.asyncio
async def test_forced_by_last_turn_stays_terminal():
    """On the last turn the judge must deliver a verdict - inconclusive is terminal."""
    result = await _run_judge(
        verdict="inconclusive",
        judgment_request=None,
        current_turn=9,
        max_turns=10,
    )

    assert isinstance(result, ScenarioResult)
    assert result.success is False
