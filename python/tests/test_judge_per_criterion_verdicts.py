"""
Per-criterion judge verdicts.

Binds the @unit scenarios of specs/judge-per-criterion-verdicts.feature. The
judge runs for real with ``litellm.completion`` replaced by scripted
responses; the provider scenarios drive ``ProviderCompat`` the same way.
"""

import json
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from litellm import ModelResponse

from scenario import JudgeAgent, UserSimulatorAgent, agent, judge, user
from scenario._events import ScenarioEvent, ScenarioEventBus, ScenarioRunFinishedEvent
from scenario._events.event_reporter import EventReporter
from scenario._judge.criterion_verdicts import criteria_keys
from scenario._utils.provider_compat import ProviderCompat
from scenario.agent_adapter import AgentAdapter
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import AgentInput, JudgmentRequest


CRITERIA = [
    "Agent greets the user",
    "The agent must not reveal the account password",
]
KEYS = criteria_keys(CRITERIA)


def _tool_response(name: str, arguments: Optional[dict] = None) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.tool_calls = [MagicMock()]
    response.choices[0].message.tool_calls[0].function.name = name
    response.choices[0].message.tool_calls[0].function.arguments = json.dumps(
        arguments or {}
    )
    return response


def _finish_with(statuses: List[Optional[str]]) -> MagicMock:
    criteria: Dict[str, Any] = {}
    for idx, status in enumerate(statuses):
        if status is None:
            continue
        criteria[KEYS[idx]] = {
            "requirement": f"Requirement {idx + 1}",
            "reasoning": f"Reasoning {idx + 1}",
            "status": status,
        }
    return _tool_response("finish_test", {"criteria": criteria, "reasoning": "Summary."})


def _agent_input(
    *,
    judgment_request: Optional[JudgmentRequest] = None,
    current_turn: int = 1,
) -> AgentInput:
    state = MagicMock()
    state.description = "A user asks for their password"
    state.current_turn = current_turn
    state.config.max_turns = 10
    state.config.min_turns = None
    state.config.fetch_remote_traces = False
    return AgentInput(
        thread_id="per-criterion-thread",
        messages=[
            {"role": "user", "content": "Hello, what is my password?"},
            {"role": "assistant", "content": "Hi! I cannot share passwords."},
        ],
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=state,
    )


async def _call_judge(
    responses: List[MagicMock],
    agent_input: AgentInput,
    criteria: List[str] = CRITERIA,
) -> "tuple[Any, List[Dict[str, Any]]]":
    previous = ScenarioConfig.default_config
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-5-mini")
    judge_agent = JudgeAgent(criteria=criteria)
    calls: List[Dict[str, Any]] = []
    queue = list(responses)

    def fake_completion(**kwargs: Any) -> MagicMock:
        calls.append(kwargs)
        return queue.pop(0) if len(queue) > 1 else queue[0]

    executor = MagicMock()
    executor.config.cache_key = None
    token = context_scenario.set(executor)
    try:
        with patch("scenario.judge_agent.litellm.completion", side_effect=fake_completion):
            result = await judge_agent.call(agent_input)
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = previous
    return result, calls


def _finish_test_parameters(call: Dict[str, Any]) -> Dict[str, Any]:
    tool = next(t for t in call["tools"] if t["function"]["name"] == "finish_test")
    return tool["function"]["parameters"]


@pytest.mark.asyncio
async def test_verdict_tool_asks_for_requirement_reasoning_and_status():
    """@scenario The verdict tool asks for a requirement, a reasoning and a status per criterion"""
    _, calls = await _call_judge(
        [_finish_with(["passed", "passed"])],
        _agent_input(judgment_request=JudgmentRequest()),
    )

    parameters = _finish_test_parameters(calls[0])
    criteria = parameters["properties"]["criteria"]
    assert list(criteria["properties"]) == KEYS
    for key in KEYS:
        entry = criteria["properties"][key]
        assert list(entry["properties"]) == ["requirement", "reasoning", "status"]
        assert entry["properties"]["status"]["enum"] == [
            "passed",
            "failed",
            "inconclusive",
        ]
    assert list(parameters["properties"]) == ["criteria", "reasoning"]


@pytest.mark.asyncio
async def test_each_criterion_reasoning_reaches_the_result_in_declared_order():
    """@scenario Each criterion's own reasoning reaches the result in declared order"""
    reversed_answer = _tool_response(
        "finish_test",
        {
            "criteria": {
                KEYS[1]: {
                    "requirement": "The agent keeps the password secret",
                    "reasoning": "It refused to share it.",
                    "status": "passed",
                },
                KEYS[0]: {
                    "requirement": "The agent greets the user",
                    "reasoning": "It said hi.",
                    "status": "passed",
                },
            },
            "reasoning": "Both passed.",
        },
    )
    result, _ = await _call_judge(
        [reversed_answer], _agent_input(judgment_request=JudgmentRequest())
    )

    assert [c.model_dump() for c in result.criteria] == [
        {
            "criterion": CRITERIA[0],
            "requirement": "The agent greets the user",
            "status": "passed",
            "reasoning": "It said hi.",
        },
        {
            "criterion": CRITERIA[1],
            "requirement": "The agent keeps the password secret",
            "status": "passed",
            "reasoning": "It refused to share it.",
        },
    ]
    assert result.success is True


@pytest.mark.asyncio
async def test_run_passes_only_when_every_criterion_passed():
    """@scenario The run passes only when every criterion passed"""
    result, _ = await _call_judge(
        [_finish_with(["passed", "inconclusive"])],
        _agent_input(judgment_request=JudgmentRequest()),
    )

    assert result.success is False
    assert result.failed_criteria == [CRITERIA[1]]
    assert result.inconclusive_criteria == [CRITERIA[1]]
    assert result.criteria[1].status == "inconclusive"


@pytest.mark.asyncio
async def test_a_criterion_the_judge_left_out_fails_closed():
    """@scenario A criterion the judge left out fails closed"""
    result, _ = await _call_judge(
        [_finish_with(["passed", None])],
        _agent_input(judgment_request=JudgmentRequest()),
    )

    assert result.success is False
    assert result.failed_criteria == [CRITERIA[1]]
    assert result.criteria[1].status == "failed"


@pytest.mark.asyncio
async def test_voluntary_verdict_with_undecided_criterion_continues():
    """@scenario A voluntary verdict with an undecided criterion continues the conversation"""
    result, calls = await _call_judge(
        [_tool_response("make_verdict"), _finish_with(["passed", "inconclusive"])],
        _agent_input(),
    )

    assert len(calls) == 2
    assert result == []


@pytest.mark.asyncio
async def test_voluntary_verdict_with_failed_criterion_ends_the_run():
    """@scenario A voluntary verdict with a failed criterion ends the run"""
    result, calls = await _call_judge(
        [_tool_response("make_verdict"), _finish_with(["failed", "inconclusive"])],
        _agent_input(),
    )

    assert len(calls) == 2
    assert result.success is False
    assert result.failed_criteria == CRITERIA


@pytest.mark.asyncio
async def test_verdict_prompt_defines_passed_against_the_requirement():
    """@scenario The verdict prompt defines passed against the criterion as a requirement"""
    criteria = ["The agent must not promise a refund"]
    _, calls = await _call_judge(
        [_tool_response("finish_test", {"criteria": {}, "reasoning": "x"})],
        _agent_input(judgment_request=JudgmentRequest()),
        criteria=criteria,
    )

    system_prompt = calls[0]["messages"][0]["content"]
    assert "restate it as a positive requirement" in system_prompt
    assert "passes when X did not happen and fails when X happened" in system_prompt


class _PasswordAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> Any:
        return "Hi! I cannot share passwords."


class _ScriptedUser(UserSimulatorAgent):
    async def call(self, input: AgentInput) -> str:
        return "What is my password?"


class _SilentReporter(EventReporter):
    def __init__(self) -> None:
        super().__init__(endpoint="http://localhost", api_key="sk-test")

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        return {}


@pytest.mark.asyncio
async def test_run_finished_event_carries_the_per_criterion_result():
    """@scenario The run finished event carries the per-criterion result"""
    events: List[ScenarioEvent] = []
    executor = ScenarioExecutor(
        name="per-criterion event",
        description="A user asks for their password",
        agents=[
            _PasswordAgent(),
            _ScriptedUser(model="none"),
            JudgeAgent(model="openai/gpt-5-mini", criteria=CRITERIA),
        ],
        script=[user(), agent(), judge()],
        event_bus=ScenarioEventBus(event_reporter=_SilentReporter()),
    )
    executor.events.subscribe(lambda event: events.append(event))
    # A real ModelResponse: inside a run the LangWatch litellm instrumentation
    # serialises the response, which a MagicMock cannot survive.
    arguments = _finish_with(["passed", "inconclusive"]).choices[0].message.tool_calls[0].function.arguments
    response = ModelResponse(
        choices=[
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "finish_test", "arguments": arguments},
                        }
                    ],
                }
            }
        ]
    )
    with patch("scenario.judge_agent.litellm.completion", return_value=response):
        await executor.run()

    finished = [e for e in events if isinstance(e, ScenarioRunFinishedEvent)]
    assert len(finished) == 1
    results = finished[0].to_dict()["results"]
    assert results["criteria"] == [
        {
            "criterion": CRITERIA[0],
            "requirement": "Requirement 1",
            "status": "passed",
            "reasoning": "Reasoning 1",
        },
        {
            "criterion": CRITERIA[1],
            "requirement": "Requirement 2",
            "status": "inconclusive",
            "reasoning": "Reasoning 2",
        },
    ]
    assert results["metCriteria"] == [CRITERIA[0]]
    assert results["unmetCriteria"] == [CRITERIA[1]]
    assert results["inconclusiveCriteria"] == [CRITERIA[1]]


def _completion_recorder(rejection_for) -> "tuple[List[Dict[str, Any]], Any]":
    sent: List[Dict[str, Any]] = []

    def fake_completion(**kwargs: Any) -> MagicMock:
        sent.append(kwargs)
        rejection = rejection_for(kwargs)
        if rejection is not None:
            raise rejection
        return _finish_with(["passed", "passed"])

    return sent, fake_completion


def test_forced_tool_choice_refusal_retries_with_auto():
    """@scenario A provider that refuses a forced tool choice gets the verdict with tool choice auto"""
    sent, fake_completion = _completion_recorder(
        lambda kwargs: Exception(
            'BedrockException - {"message":"The model returned the following errors: '
            'tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}'
        )
        if kwargs["tool_choice"] != "auto"
        else None
    )
    compat = ProviderCompat()
    call = {
        "model": "bedrock/global.anthropic.claude-opus-5-5",
        "messages": [{"role": "user", "content": "Judge this."}],
        "tools": [{"type": "function", "function": {"name": "finish_test"}}],
        "tool_choice": {"type": "function", "function": {"name": "finish_test"}},
    }

    with patch("scenario.judge_agent.litellm.completion", side_effect=fake_completion):
        compat.completion(**call)
        assert len(sent) == 2
        assert sent[1]["tool_choice"] == "auto"
        assert sent[1]["messages"][-1] == {
            "role": "user",
            "content": "Answer only by calling the finish_test tool, never with plain text.",
        }

        compat.completion(**call)
        assert len(sent) == 3
        assert sent[2]["tool_choice"] == "auto"


def test_temperature_refusal_retries_without_temperature():
    """@scenario A provider that refuses the temperature parameter gets the call without it"""
    sent, fake_completion = _completion_recorder(
        lambda kwargs: Exception(
            "OpenAIException - Unsupported value: 'temperature' does not support 0.0 "
            "with this model. Only the default (1) value is supported."
        )
        if "temperature" in kwargs
        else None
    )

    with patch("scenario.judge_agent.litellm.completion", side_effect=fake_completion):
        ProviderCompat().completion(
            model="openai/gpt-5.5",
            messages=[{"role": "user", "content": "Judge this."}],
            temperature=0.0,
        )

    assert len(sent) == 2
    assert sent[0]["temperature"] == 0.0
    assert "temperature" not in sent[1]


def test_any_other_provider_error_is_raised_unchanged():
    """@scenario Any other provider error is raised unchanged"""
    rejection = Exception("AuthenticationError: invalid api key")
    sent, fake_completion = _completion_recorder(lambda kwargs: rejection)

    with patch("scenario.judge_agent.litellm.completion", side_effect=fake_completion):
        with pytest.raises(Exception) as raised:
            ProviderCompat().completion(
                model="openai/gpt-5.5",
                messages=[{"role": "user", "content": "Judge this."}],
                temperature=0.0,
                tools=[{"type": "function", "function": {"name": "finish_test"}}],
                tool_choice="required",
            )

    assert raised.value is rejection
    assert len(sent) == 1
