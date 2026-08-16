"""
Unit tests for remote trace fetching wired into the judge and the executor.

Binds the @unit scenarios of specs/remote-trace-fetching.feature:
"AgentInput carries W3C propagation headers for the current turn",
"The judge fetches traces for every turn, not only the last",
"Conversation turns never fetch remote traces",
"A forced verdict settle-waits until the remote trace is complete",
"A make_verdict decision settles the traces before the verdict",
"Fetch failure produces a synthetic error span and inconclusive criteria
guidance" (the judge prompt half),
"The judge may wait once more when the traces are incomplete" (the judge
half), "The extra wait is available once",
"The trace wait budget defaults to 30 seconds", and
"Remote fetching is off by default".
"""

import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, cast
from unittest.mock import MagicMock, patch

import pytest

from scenario import AgentRole, JudgeAgent, configure
from scenario.agent_adapter import AgentAdapter
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.judge_agent import (
    REMOTE_TRACES_DECISION_RULE,
    REMOTE_TRACES_JUDGE_RULE,
)
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import (
    AgentInput,
    AgentReturnTypes,
    JudgmentRequest,
    ScenarioResult,
)
from scenario._tracing import ensure_tracing_initialized
from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario._tracing.remote_trace_fetcher import (
    RemoteTraceFetcher,
    convert_api_span,
)


THREAD_ID = "scenariothread_judging"
TRACE_A = "0af7651916cd43dd8448eb211c80319c"
TRACE_B = "1bf7651916cd43dd8448eb211c80319d"
TRACE_C = "2cf7651916cd43dd8448eb211c80319e"


class RecordingFetcher(RemoteTraceFetcher):
    """Fetcher double recording how the judge drives it.

    The HTTP layer raises if reached, so any fetch outside the recorded
    ``settle_traces`` surface fails the test loudly.
    """

    def __init__(
        self,
        *,
        spans_on_settle: Optional[List[Any]] = None,
        all_settled: bool = True,
    ) -> None:
        super().__init__(fetch_trace=self._never_called)
        self.settle_calls: List[Dict[str, Any]] = []
        self.extend_calls: List[Dict[str, Any]] = []
        self._spans_on_settle = spans_on_settle or []
        self._settle_result = all_settled

    @staticmethod
    async def _never_called(trace_id: str) -> Optional[Dict[str, Any]]:
        raise AssertionError("the HTTP layer must not be reached in this test")

    async def settle_traces(
        self,
        *,
        thread_id: str,
        trace_ids: Sequence[str],
        collector: JudgeSpanCollector,
        timeout: float,
    ) -> bool:
        self.settle_calls.append({"trace_ids": list(trace_ids), "timeout": timeout})
        for span in self._spans_on_settle:
            collector.on_end(span)
        # all_settled=False leaves the traces incomplete, which is what
        # offers the judge its wait_for_traces extension.
        return self._settle_result

    async def extend_settle(
        self,
        *,
        thread_id: str,
        trace_ids: Sequence[str],
        collector: JudgeSpanCollector,
        timeout: float,
    ) -> bool:
        self.extend_calls.append({"trace_ids": list(trace_ids), "timeout": timeout})
        self._settle_result = True
        return True


def _scenario_state(
    *,
    current_turn: int = 1,
    max_turns: int = 10,
    fetch_remote_traces: Optional[bool] = True,
    trace_wait_timeout: Optional[float] = None,
    trace_wait_extension: Optional[float] = None,
) -> MagicMock:
    state = MagicMock()
    state.description = "Test scenario"
    state.current_turn = current_turn
    state.config = ScenarioConfig(
        max_turns=max_turns,
        fetch_remote_traces=fetch_remote_traces,
        trace_wait_timeout=trace_wait_timeout,
        trace_wait_extension=trace_wait_extension,
    )
    return state


def _agent_input(
    *,
    messages: List[Dict[str, Any]],
    judgment_request: Optional[JudgmentRequest] = None,
    current_turn: int = 1,
    max_turns: int = 10,
    fetch_remote_traces: Optional[bool] = True,
    trace_wait_timeout: Optional[float] = None,
    trace_wait_extension: Optional[float] = None,
) -> AgentInput:
    return AgentInput(
        thread_id=THREAD_ID,
        messages=cast(Any, messages),
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=_scenario_state(
            current_turn=current_turn,
            max_turns=max_turns,
            fetch_remote_traces=fetch_remote_traces,
            trace_wait_timeout=trace_wait_timeout,
            trace_wait_extension=trace_wait_extension,
        ),
    )


def _finish_test_response(
    *,
    verdict: str = "success",
    reasoning: str = "done",
    criteria: Optional[Dict[str, str]] = None,
) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = "finish_test"
    response.choices[0].message.tool_calls[0].function.arguments = json.dumps(
        {
            "verdict": verdict,
            "reasoning": reasoning,
            "criteria": criteria or {"test_criterion": "true"},
        }
    )
    return response


def _continue_test_response() -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = "continue_test"
    response.choices[0].message.tool_calls[0].function.arguments = "{}"
    return response


def _make_verdict_response() -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = "make_verdict"
    response.choices[0].message.tool_calls[0].function.arguments = "{}"
    return response


def _wait_for_traces_response() -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = "wait_for_traces"
    response.choices[0].message.tool_calls[0].function.arguments = "{}"
    return response


def _tool_names(call_kwargs: Mapping[str, Any]) -> List[str]:
    return [tool["function"]["name"] for tool in call_kwargs["tools"]]


def _cache_context():
    executor = MagicMock()
    executor.config = MagicMock()
    executor.config.cache_key = None
    return context_scenario.set(executor)


def _three_turn_messages() -> List[Dict[str, Any]]:
    return [
        {"role": "user", "content": "turn one", "trace_id": TRACE_A},
        {"role": "assistant", "content": "reply one", "trace_id": TRACE_A},
        {"role": "user", "content": "turn two", "trace_id": TRACE_B},
        {"role": "assistant", "content": "reply two", "trace_id": TRACE_B},
        {"role": "user", "content": "turn three", "trace_id": TRACE_C},
        {"role": "assistant", "content": "reply three", "trace_id": TRACE_C},
    ]


@pytest.mark.asyncio
async def test_judge_fetches_traces_for_every_turn_not_only_the_last():
    """@scenario The judge fetches traces for every turn, not only the last"""
    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ):
            await judge.call(
                _agent_input(
                    messages=_three_turn_messages(),
                    judgment_request=JudgmentRequest(),
                )
            )
    finally:
        context_scenario.reset(token)

    assert fetcher.settle_calls == [
        {"trace_ids": [TRACE_A, TRACE_B, TRACE_C], "timeout": 30.0}
    ]


@pytest.mark.asyncio
async def test_conversation_turns_never_fetch_remote_traces():
    """@scenario Conversation turns never fetch remote traces"""
    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_continue_test_response(),
        ):
            result = await judge.call(
                _agent_input(messages=_three_turn_messages(), current_turn=1)
            )
    finally:
        context_scenario.reset(token)

    # A continue decision costs zero fetches: no settle-wait, and the
    # RecordingFetcher's HTTP layer would have raised on any request.
    assert result == []
    assert fetcher.settle_calls == []


@pytest.mark.asyncio
async def test_forced_verdict_settle_waits_and_fetched_spans_reach_the_digest():
    """@scenario A forced verdict settle-waits until the remote trace is complete"""
    remote_span = convert_api_span(
        {
            "trace_id": TRACE_A,
            "span_id": "a" * 16,
            "name": "query requirements table",
            "type": "tool",
        },
        trace_id=TRACE_A,
        thread_id=THREAD_ID,
    )
    assert remote_span is not None
    collector = JudgeSpanCollector()
    fetcher = RecordingFetcher(spans_on_settle=[remote_span])
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=collector,
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    current_turn=9,
                    max_turns=10,
                    trace_wait_timeout=12.5,
                )
            )
    finally:
        context_scenario.reset(token)

    assert fetcher.settle_calls == [{"trace_ids": [TRACE_A], "timeout": 12.5}]
    user_message = next(
        m for m in completion.call_args.kwargs["messages"] if m["role"] == "user"
    )
    content = user_message["content"]
    traces_section = content.split("<opentelemetry_traces>")[1].split(
        "</opentelemetry_traces>"
    )[0]
    assert "query requirements table" in traces_section


@pytest.mark.asyncio
async def test_make_verdict_decision_settles_traces_before_the_verdict():
    """@scenario A make_verdict decision settles the traces before the verdict"""
    remote_span = convert_api_span(
        {
            "trace_id": TRACE_A,
            "span_id": "b" * 16,
            "name": "late arriving tool span",
            "type": "tool",
        },
        trace_id=TRACE_A,
        thread_id=THREAD_ID,
    )
    assert remote_span is not None
    fetcher = RecordingFetcher(spans_on_settle=[remote_span])
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    decision = _make_verdict_response()
    verdict = _finish_test_response(reasoning="verdict with complete traces")
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=[decision, verdict],
        ) as completion:
            result = await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    current_turn=1,
                )
            )
    finally:
        context_scenario.reset(token)

    assert completion.call_count == 2, "one decision call, one verdict call"
    assert fetcher.settle_calls == [{"trace_ids": [TRACE_A], "timeout": 30.0}]
    verdict_call_kwargs = completion.call_args_list[1].kwargs
    assert verdict_call_kwargs["tool_choice"] == {
        "type": "function",
        "function": {"name": "finish_test"},
    }
    verdict_user_message = next(
        m for m in verdict_call_kwargs["messages"] if m["role"] == "user"
    )
    assert "late arriving tool span" in verdict_user_message["content"]

    decision_call_kwargs = completion.call_args_list[0].kwargs
    decision_user_message = next(
        m for m in decision_call_kwargs["messages"] if m["role"] == "user"
    )
    assert "late arriving tool span" not in decision_user_message["content"], (
        "the settle-wait ran after the decision, before the verdict prompt"
    )
    assert isinstance(result, ScenarioResult)
    assert result.reasoning == "verdict with complete traces"


@pytest.mark.asyncio
async def test_voluntary_inconclusive_verdict_is_terminal_when_no_trace_ever_settled():
    """@scenario A voluntary inconclusive verdict is terminal when no remote trace ever settled"""
    # Nothing ever settles: the settle records the call but no trace reaches
    # the settled state, so the run's remote evidence cannot improve.
    fetcher = RecordingFetcher(spans_on_settle=[])
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    decision = _make_verdict_response()
    verdict = _finish_test_response(
        verdict="inconclusive",
        reasoning="No trace evidence arrived for the write.",
        criteria={"test_criterion": "inconclusive"},
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=[decision, verdict],
        ) as completion:
            result = await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    current_turn=1,
                )
            )
    finally:
        context_scenario.reset(token)

    assert completion.call_count == 2, "one decision call, one verdict call"
    # A continuing judge returns None; here the verdict must stand, because
    # more turns cannot produce trace evidence for this run.
    assert isinstance(result, ScenarioResult)
    assert result.success is False


@pytest.mark.asyncio
async def test_judge_system_prompt_carries_the_trace_verification_rule():
    """@scenario Fetch failure produces a synthetic error span and inconclusive criteria guidance"""
    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    judgment_request=JudgmentRequest(),
                )
            )
    finally:
        context_scenario.reset(token)

    system_message = completion.call_args.kwargs["messages"][0]
    assert system_message["role"] == "system"
    assert REMOTE_TRACES_JUDGE_RULE in system_message["content"]


@pytest.mark.asyncio
async def test_judge_system_prompt_omits_the_rule_when_fetching_is_off():
    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ) as completion:
            await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    judgment_request=JudgmentRequest(),
                    fetch_remote_traces=None,
                )
            )
    finally:
        context_scenario.reset(token)

    system_message = completion.call_args.kwargs["messages"][0]
    assert REMOTE_TRACES_JUDGE_RULE not in system_message["content"]


@pytest.mark.asyncio
async def test_decision_prompt_defers_traces_to_the_verdict():
    """The decision call tells the judge traces are fetched at the verdict,
    so it neither stalls waiting for them nor rushes to see them."""
    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_continue_test_response(),
        ) as completion:
            await judge.call(
                _agent_input(messages=_three_turn_messages(), current_turn=1)
            )
    finally:
        context_scenario.reset(token)

    system_message = completion.call_args.kwargs["messages"][0]
    assert REMOTE_TRACES_DECISION_RULE in system_message["content"]
    assert REMOTE_TRACES_JUDGE_RULE not in system_message["content"]


@pytest.mark.asyncio
async def test_remote_fetching_is_off_by_default():
    """@scenario Remote fetching is off by default"""
    assert ScenarioConfig().fetch_remote_traces is None

    fetcher = RecordingFetcher()
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=_finish_test_response(),
        ):
            await judge.call(
                _agent_input(
                    messages=_three_turn_messages(),
                    judgment_request=JudgmentRequest(),
                    fetch_remote_traces=None,
                )
            )
    finally:
        context_scenario.reset(token)

    assert fetcher.settle_calls == []


@pytest.mark.asyncio
async def test_incomplete_traces_offer_the_wait_tool_and_the_judge_waits_once():
    """@scenario The judge may wait once more when the traces are incomplete"""
    fetcher = RecordingFetcher(all_settled=False)
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=[_wait_for_traces_response(), _finish_test_response()],
        ) as completion:
            result = await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    judgment_request=JudgmentRequest(),
                    trace_wait_timeout=12.5,
                    trace_wait_extension=7.0,
                )
            )
    finally:
        context_scenario.reset(token)

    assert completion.call_count == 2, "the wait call, then the verdict call"
    first_call = completion.call_args_list[0].kwargs
    assert "wait_for_traces" in _tool_names(first_call)
    assert "finish_test" in _tool_names(first_call)
    assert first_call["tool_choice"] == "required", (
        "with the wait tool offered the pin relaxes so the judge can pick"
        " either tool"
    )

    assert fetcher.extend_calls == [{"trace_ids": [TRACE_A], "timeout": 7.0}]
    assert [call["timeout"] for call in fetcher.settle_calls] == [12.5, 12.5]
    assert isinstance(result, ScenarioResult)


@pytest.mark.asyncio
async def test_the_extra_wait_is_available_once():
    """@scenario The extra wait is available once"""
    fetcher = RecordingFetcher(all_settled=False)
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=[_wait_for_traces_response(), _finish_test_response()],
        ) as completion:
            await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    judgment_request=JudgmentRequest(),
                )
            )
    finally:
        context_scenario.reset(token)

    second_call = completion.call_args_list[1].kwargs
    assert "wait_for_traces" not in _tool_names(second_call)
    assert second_call["tool_choice"] == {
        "type": "function",
        "function": {"name": "finish_test"},
    }
    waited_note = second_call["messages"][-1]
    assert waited_note["role"] == "user"
    assert "already waited once more" in waited_note["content"]


@pytest.mark.asyncio
async def test_the_wait_budget_and_its_extension_default_to_30_seconds():
    """@scenario The trace wait budget defaults to 30 seconds"""
    fetcher = RecordingFetcher(all_settled=False)
    judge = JudgeAgent(
        criteria=["Test criterion"],
        model="openai/gpt-5-mini",
        remote_trace_fetcher=fetcher,
        span_collector=JudgeSpanCollector(),
    )
    token = _cache_context()
    try:
        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=[_wait_for_traces_response(), _finish_test_response()],
        ):
            await judge.call(
                _agent_input(
                    messages=[
                        {"role": "user", "content": "hello", "trace_id": TRACE_A}
                    ],
                    judgment_request=JudgmentRequest(),
                )
            )
    finally:
        context_scenario.reset(token)

    assert fetcher.settle_calls[0]["timeout"] == 30.0
    assert fetcher.extend_calls == [{"trace_ids": [TRACE_A], "timeout": 30.0}], (
        "the extension budget defaults to the resolved wait budget"
    )


def test_configure_and_executor_kwargs_carry_the_new_config_fields():
    previous_default_config = ScenarioConfig.default_config
    try:
        configure(
            fetch_remote_traces=True,
            trace_wait_timeout=17.0,
            trace_wait_extension=19.0,
        )
        assert ScenarioConfig.default_config is not None
        assert ScenarioConfig.default_config.fetch_remote_traces is True
        assert ScenarioConfig.default_config.trace_wait_timeout == 17.0
        assert ScenarioConfig.default_config.trace_wait_extension == 19.0

        executor = ScenarioExecutor(
            name="test",
            description="test",
            agents=[],
            trace_wait_timeout=23.0,
        )
        assert executor.config.fetch_remote_traces is True
        assert executor.config.trace_wait_timeout == 23.0
        assert executor.config.trace_wait_extension == 19.0
    finally:
        ScenarioConfig.default_config = previous_default_config


# --------------------------------------------------------------------- #
# Propagation headers                                                    #
# --------------------------------------------------------------------- #


def test_agent_input_propagation_headers_default_to_an_empty_dict():
    agent_input = AgentInput(
        thread_id="t",
        messages=[],
        new_messages=[],
        judgment_request=None,
        scenario_state=MagicMock(),
    )
    assert agent_input.propagation_headers == {}


class _CapturingAgent(AgentAdapter):
    """Agent under test that records the AgentInput it receives."""

    def __init__(self) -> None:
        self.received: List[AgentInput] = []

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        self.received.append(input)
        return {"role": "assistant", "content": "captured"}


class _ScriptedUser(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hello agent"


@pytest.mark.asyncio
async def test_agent_input_carries_traceparent_matching_the_turn_trace_id():
    """@scenario AgentInput carries W3C propagation headers for the current turn"""
    ensure_tracing_initialized(None)
    capturing_agent = _CapturingAgent()
    executor = ScenarioExecutor(
        name="propagation test",
        description="propagation headers reach the agent adapter",
        agents=[capturing_agent, _ScriptedUser()],
    )
    executor.reset()

    await executor.step()  # user turn
    await executor.step()  # agent turn

    assert capturing_agent.received, "the agent under test was called"
    agent_input = capturing_agent.received[0]
    headers = agent_input.propagation_headers
    assert "traceparent" in headers

    traceparent_trace_id = headers["traceparent"].split("-")[1]
    message_trace_ids = {
        m.get("trace_id") for m in agent_input.messages if isinstance(m, dict)
    }
    assert traceparent_trace_id in message_trace_ids, (
        "the traceparent trace id equals the trace id stamped on the "
        "turn's messages"
    )
