"""
Regression for #864: the judge could not reach a verdict on a reasoning model.

    litellm.BadRequestError: OpenAIException - Function tools with
    reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions.
    To use function tools, use /v1/responses or set reasoning_effort to 'none'.

The judge forces a `finish_test` / `continue_test` function-tool call on every
graded run, so on such a model every run died before a verdict. Verified live
against `/v1/chat/completions`: the same request answers 400 without
`reasoning_effort` and 200 with `reasoning_effort="none"`.

Reasoning is disabled by RETRY, never preemptively. Whether a model accepts
reasoning off is not knowable up front — Gemini 2.5 Pro rejects it with
"Budget 0 is invalid. This model only works in thinking mode." — so the call
goes out untouched and is re-sent with reasoning off only when the provider's
rejection asks for exactly that. Models that work today are never sent
anything new.

The example that would have caught this (`examples/test_audio_to_text.py`) was
skipped in CI, which is how it sat unnoticed. These tests are offline and
deterministic so the rule is pinned on every pull request, with no key, no
network and no live model — the live example is a poor gate for a wire-shape
rule even now that it runs.

The sibling fix on the LangWatch platform judge is langwatch/langwatch#6369.
"""

from typing import Any, Optional
from unittest.mock import MagicMock, patch

import litellm
import pytest

from scenario import JudgeAgent
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest

_REJECTION_MESSAGE = (
    "OpenAIException - Function tools with reasoning_effort are not supported "
    "for gpt-5.6-luna in /v1/chat/completions. To use function tools, use "
    "/v1/responses or set reasoning_effort to 'none'."
)


def _bad_request(message: str) -> litellm.BadRequestError:
    return litellm.BadRequestError(
        message=message, model="gpt-5.6-luna", llm_provider="openai"
    )


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


def _rejecting_completion(rejection: Exception) -> Any:
    """A litellm.completion double enforcing the provider's rule: tool-carrying
    calls are rejected unless reasoning_effort is "none"."""

    def completion(**kwargs: Any) -> Any:
        if kwargs.get("tools") and kwargs.get("reasoning_effort") != "none":
            raise rejection
        return _finish_test_response()

    return completion


async def _call_judge(
    judge: JudgeAgent,
    agent_input: AgentInput,
    completion: Optional[Any] = None,
) -> Any:
    """Run the judge with litellm stubbed, returning the mock for inspection."""
    executor = MagicMock()
    executor.config = MagicMock()
    executor.config.cache_key = None
    token = context_scenario.set(executor)
    try:
        with patch("scenario.judge_agent.litellm.completion") as mock:
            if completion is None:
                mock.return_value = _finish_test_response()
            else:
                mock.side_effect = completion
            await judge.call(agent_input)
            assert mock.called
            return mock
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


class TestGivenAProviderThatRejectsToolsWithoutReasoningOff:
    @pytest.mark.asyncio
    async def test_retries_with_reasoning_off_and_reaches_a_verdict(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

        mock = await _call_judge(
            judge, _agent_input(), _rejecting_completion(_bad_request(_REJECTION_MESSAGE))
        )

        assert mock.call_count == 2
        first, second = (call.kwargs for call in mock.call_args_list)
        assert "reasoning_effort" not in first
        assert second["reasoning_effort"] == "none"

    @pytest.mark.asyncio
    async def test_preserves_an_explicitly_requested_effort(self):
        """A caller that asked for a specific effort keeps it — the provider's
        own rejection surfaces instead of the intent being rewritten."""
        judge = JudgeAgent(
            criteria=["c"],
            model="openai/gpt-5.6-luna",
            reasoning_effort="high",
        )

        with pytest.raises(litellm.BadRequestError):
            await _call_judge(
                judge,
                _agent_input(),
                _rejecting_completion(_bad_request(_REJECTION_MESSAGE)),
            )


class TestGivenAProviderThatAcceptsTheCall:
    @pytest.mark.asyncio
    async def test_sends_exactly_one_untouched_request(self):
        """The Gemini 2.5 Pro shape: a judge that works must never be sent
        reasoning off, because the model may refuse to disable it."""
        judge = JudgeAgent(criteria=["c"], model="gemini/gemini-2.5-pro")

        mock = await _call_judge(judge, _agent_input())

        assert mock.call_count == 1
        assert "reasoning_effort" not in mock.call_args.kwargs
        assert mock.call_args.kwargs["tools"], "the judge must be sending function tools"


class TestGivenAnUnrelatedRejection:
    @pytest.mark.asyncio
    async def test_surfaces_the_rejection_without_retrying(self):
        judge = JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")
        unrelated = _bad_request("Unsupported value for parameter 'temperature'.")

        with pytest.raises(litellm.BadRequestError):
            await _call_judge(
                judge, _agent_input(), _rejecting_completion(unrelated)
            )


class TestEveryCallSiteThatSendsTools:
    """
    The judge reaches `litellm.completion` from three places. A retry helper
    that is correct but not wired at one of them fails exactly where it is
    hardest to notice — the large-trace paths, which only a big conversation
    reaches. Each site is pinned here so an unwired one cannot pass by way of
    the others.
    """

    _TOOLS = [
        {
            "type": "function",
            "function": {"name": "finish_test", "description": "finish"},
        }
    ]

    def _judge(self) -> JudgeAgent:
        return JudgeAgent(criteria=["c"], model="openai/gpt-5.6-luna")

    def test_the_discovery_loop_retries_with_reasoning_off(self):
        judge = self._judge()

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=_rejecting_completion(_bad_request(_REJECTION_MESSAGE)),
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

    def test_the_forced_verdict_retries_with_reasoning_off(self):
        judge = self._judge()

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=_rejecting_completion(_bad_request(_REJECTION_MESSAGE)),
        ) as completion:
            judge._force_verdict(
                messages=[{"role": "user", "content": "hi"}],
                tools=self._TOOLS,
                effective_criteria=["c"],
                input_messages=[],
            )

        assert completion.call_args.kwargs["reasoning_effort"] == "none"
