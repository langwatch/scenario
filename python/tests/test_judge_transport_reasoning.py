"""
Regression for #864: the judge could not reach a verdict on a reasoning model.

    litellm.BadRequestError: OpenAIException - Function tools with
    reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions.
    To use function tools, use /v1/responses or set reasoning_effort to 'none'.

The judge forces a `finish_test` / `continue_test` function-tool call on every
graded run, so on such a model every run died before a verdict. Verified live
against `/v1/chat/completions`: the same request answers 400 without
`reasoning_effort` and 200 with `reasoning_effort="none"`.

The example that would have caught this (`examples/test_audio_to_text.py`) was
skipped in CI, which is how it sat unnoticed. These tests are offline and
deterministic so the rule is pinned on every pull request, with no key, no
network and no live model — the live example is a poor gate for a wire-shape
rule even now that it runs.

The sibling fix on the LangWatch platform judge is langwatch/langwatch#6369.
"""

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from scenario import JudgeAgent
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest


def _agent_input(turn: int = 1, max_turns: int = 10) -> AgentInput:
    scenario_state = MagicMock()
    scenario_state.description = "Test scenario"
    scenario_state.current_turn = turn
    scenario_state.config.max_turns = max_turns
    return AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=JudgmentRequest(),
        scenario_state=scenario_state,
    )


def _finish_test_response() -> Any:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = "finish_test"
    response.choices[0].message.tool_calls[0].function.arguments = (
        '{"verdict": "success", "reasoning": "ok", "criteria": {"c": true}}'
    )
    return response


async def _call_judge(judge: JudgeAgent, agent_input: AgentInput) -> Any:
    """Run the judge with litellm stubbed, returning the recorded call kwargs."""
    executor = MagicMock()
    executor.config = MagicMock()
    executor.config.cache_key = None
    token = context_scenario.set(executor)
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            await judge.call(agent_input)
            assert completion.called
            return completion.call_args.kwargs
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


class TestGivenAModelThatAcceptsReasoningEffort:
    @pytest.mark.asyncio
    async def test_declares_reasoning_off_when_it_sends_function_tools(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

        kwargs = await _call_judge(judge, _agent_input())

        assert kwargs["tools"], "the judge must be sending function tools"
        assert kwargs["reasoning_effort"] == "none"

    @pytest.mark.asyncio
    async def test_preserves_an_explicitly_requested_effort(self):
        judge = JudgeAgent(
            criteria=["c"],
            model="openai/gpt-5.6-luna",
            reasoning_effort="high",
        )

        kwargs = await _call_judge(judge, _agent_input())

        assert kwargs["reasoning_effort"] == "high"


class TestGivenAModelThatDoesNotAcceptReasoningEffort:
    @pytest.mark.asyncio
    async def test_sends_no_reasoning_effort(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-4o")

        kwargs = await _call_judge(judge, _agent_input())

        assert kwargs["tools"], "the judge must be sending function tools"
        assert "reasoning_effort" not in kwargs


class TestGivenAnUnknownModel:
    @pytest.mark.asyncio
    async def test_sends_no_reasoning_effort(self):
        """Absent capability metadata is not permission — sending the parameter
        to a model that does not take it is itself a 400."""
        judge = JudgeAgent(criteria=["c"], model="openai/some-private-deployment")

        kwargs = await _call_judge(judge, _agent_input())

        assert "reasoning_effort" not in kwargs


class TestTheReasoningKwargItself:
    """The rule is 'tools present', not 'judge running' — every call site that
    can send tools must be covered, and one that sends none must not be."""

    def test_no_tools_means_no_reasoning_effort(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

        assert judge._reasoning_kwargs([]) == {}

    def test_tools_on_a_reasoning_model_declare_reasoning_off(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

        assert judge._reasoning_kwargs([{"type": "function"}]) == {
            "reasoning_effort": "none"
        }


class TestEveryCallSiteThatSendsTools:
    """
    The judge reaches `litellm.completion` from three places. A helper that is
    correct but not wired at one of them fails exactly where it is hardest to
    notice — the large-trace paths, which only a big conversation reaches. Each
    site is pinned here so an unwired one cannot pass by way of the others.
    """

    _TOOLS = [
        {
            "type": "function",
            "function": {"name": "finish_test", "description": "finish"},
        }
    ]

    def _judge(self) -> JudgeAgent:
        return JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

    def test_the_discovery_loop_declares_reasoning_off(self):
        judge = self._judge()

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            judge._run_discovery_loop(
                messages=[{"role": "user", "content": "hi"}],
                tools=self._TOOLS,
                tool_choice="required",
                spans=[],
                working_messages=[],
                effective_criteria=["c"],
                input_messages=[],
            )

        assert completion.call_args.kwargs["reasoning_effort"] == "none"

    def test_the_forced_verdict_declares_reasoning_off(self):
        judge = self._judge()

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            judge._force_verdict(
                messages=[{"role": "user", "content": "hi"}],
                tools=self._TOOLS,
                effective_criteria=["c"],
                input_messages=[],
            )

        assert completion.call_args.kwargs["reasoning_effort"] == "none"
