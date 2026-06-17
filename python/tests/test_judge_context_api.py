"""Tests for the additional_context parameter on ScenarioExecutor.judge() and script.judge().

These tests enter through ScenarioExecutor.judge() — NOT through a hand-built
JudgmentRequest — to verify that the public API wires additional_context all the way down
to the LLM call. See issue #660.
"""

import warnings
import pytest
from unittest.mock import patch, MagicMock

from scenario import JudgeAgent
from scenario.config import ScenarioConfig
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import JudgmentRequest


def _make_mock_litellm_response(verdict: str = "success") -> MagicMock:
    """Build a minimal litellm completion mock that JudgeAgent.call() accepts."""
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[0].function.arguments = (
        '{"verdict": "' + verdict + '", "reasoning": "ok", "criteria": {}}'
    )
    return mock_response


def _make_executor(criteria=None) -> ScenarioExecutor:
    """Return an initialised ScenarioExecutor with a single JudgeAgent."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    executor = ScenarioExecutor(
        name="context test",
        description="test description",
        agents=[
            JudgeAgent(criteria=criteria or ["agent responded"]),
        ],
    )
    executor.reset()
    return executor


def _get_user_message(mock_completion: MagicMock) -> str:
    """Extract the content of the first user-role message from litellm call args."""
    call_kwargs = mock_completion.call_args.kwargs
    messages = call_kwargs["messages"]
    user_msg = next(m for m in messages if m["role"] == "user")
    return user_msg["content"]


def _get_system_message(mock_completion: MagicMock) -> str:
    """Extract the content of the system message from litellm call args."""
    call_kwargs = mock_completion.call_args.kwargs
    messages = call_kwargs["messages"]
    sys_msg = next(m for m in messages if m["role"] == "system")
    return sys_msg["content"]


@pytest.mark.asyncio
async def test_executor_judge_additional_context_forwarded_to_llm_input():
    """executor.judge(additional_context=...) must include <additional_context> in the LLM user message."""
    ctx_text = "the agent ran npm install which exited 0"
    executor = _make_executor()
    mock_response = _make_mock_litellm_response()

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await executor.judge(additional_context=ctx_text)

            assert mock_completion.called
            content = _get_user_message(mock_completion)
            assert "<additional_context>" in content
            assert ctx_text in content
            assert "</additional_context>" in content
    finally:
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_executor_judge_criteria_and_additional_context_forwarded_independently():
    """executor.judge(criteria=[...], additional_context=...) forwards both criteria and additional_context."""
    ctx_text = "exit code 0"
    executor = _make_executor()
    mock_response = _make_mock_litellm_response()

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await executor.judge(
                criteria=["agent installed dependency"], additional_context=ctx_text
            )

            assert mock_completion.called
            user_content = _get_user_message(mock_completion)
            sys_content = _get_system_message(mock_completion)
            # context block present in user message
            assert "<additional_context>" in user_content
            assert ctx_text in user_content
            assert "</additional_context>" in user_content
            # criteria present in system message (judge includes them in <criteria>)
            assert "agent installed dependency" in sys_content
    finally:
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_executor_judge_no_context_no_additional_context_block_no_args():
    """executor.judge() with no arguments must NOT emit <additional_context>."""
    executor = _make_executor()
    mock_response = _make_mock_litellm_response()

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await executor.judge()

            assert mock_completion.called
            content = _get_user_message(mock_completion)
            assert "<additional_context>" not in content
    finally:
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_executor_judge_no_context_no_additional_context_block_criteria_only():
    """executor.judge(criteria=[...]) with no context must NOT emit <additional_context>."""
    executor = _make_executor()
    mock_response = _make_mock_litellm_response()

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await executor.judge(criteria=["agent responded"])

            assert mock_completion.called
            content = _get_user_message(mock_completion)
            assert "<additional_context>" not in content
    finally:
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_executor_judge_empty_string_additional_context_no_additional_context_block():
    """executor.judge(additional_context='') must NOT emit <additional_context> (truthy guard)."""
    executor = _make_executor()
    mock_response = _make_mock_litellm_response()

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await executor.judge(additional_context="")

            assert mock_completion.called
            content = _get_user_message(mock_completion)
            assert "<additional_context>" not in content
    finally:
        ScenarioConfig.default_config = None


# ---------------------------------------------------------------------------
# JudgmentRequest deprecated context alias tests
# ---------------------------------------------------------------------------


def test_judgment_request_deprecated_context_alias_migrates_to_additional_context():
    """JudgmentRequest(context=...) should migrate the value to additional_context and warn."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        req = JudgmentRequest(context="legacy value")

    assert req.additional_context == "legacy value"
    assert any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_judgment_request_additional_context_wins_over_deprecated_context():
    """When both are set, additional_context takes precedence and no migration occurs."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        req = JudgmentRequest(additional_context="new value", context="old value")

    assert req.additional_context == "new value"
    assert not any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_judgment_request_deprecated_context_alias_migrates_field():
    """JudgmentRequest(context=...) normalises to additional_context at construction time."""
    ctx_text = "legacy context via deprecated field"
    req = JudgmentRequest(context=ctx_text)
    assert req.additional_context == ctx_text
