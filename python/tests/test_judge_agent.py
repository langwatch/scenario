import json
import pytest
from typing import Any, Optional, cast
from unittest.mock import patch, MagicMock
from openai import OpenAI
from scenario import JudgeAgent
from scenario.config import ModelConfig, ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest, ScenarioResult
from scenario.cache import context_scenario
from scenario.scenario_executor import ScenarioExecutor


class FakeOpenAIClient:
    """Fake client for testing without requiring API keys."""

    def __init__(self, base_url=None, default_headers=None):
        self.base_url = base_url
        self.default_headers = default_headers


@pytest.mark.asyncio
async def test_judge_agent_merges_global_config_and_agent_params():
    """JudgeAgent merges ModelConfig defaults with agent-specific overrides, including custom client."""
    # Setup custom client
    custom_client = FakeOpenAIClient(
        base_url="https://custom.com", default_headers={"X-Global": "global-value"}
    )

    # Setup global config with extra params
    ScenarioConfig.default_config = ScenarioConfig(
        default_model=ModelConfig(
            model="openai/gpt-4",
            api_base="https://custom.com",
            headers={"X-Global": "global-value"},  # type: ignore  # extra param via ConfigDict(extra="allow")
            timeout=30,  # type: ignore  # extra param via ConfigDict(extra="allow")
            client=custom_client,  # type: ignore  # extra param via ConfigDict(extra="allow")
        )
    )

    judge = JudgeAgent(
        criteria=["Test criterion"],
        temperature=0.5,
        timeout=60,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=JudgmentRequest(),
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "Test passed", "criteria": {"test_criterion": true}}'

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs

            # Verify merged params: config defaults + agent overrides
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["api_base"] == "https://custom.com"
            assert call_kwargs["temperature"] == 0.5  # Agent override
            assert call_kwargs["timeout"] == 60  # Agent override
            assert call_kwargs["headers"] == {"X-Global": "global-value"}  # From config
            assert (
                call_kwargs["client"] == custom_client
            )  # Custom client passed through
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_agent_with_string_default_model_config():
    """JudgeAgent should initialize _extra_params when default_model is a string."""
    # Setup global config with string default_model
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

    judge = JudgeAgent(
        criteria=["Test criterion"],
        temperature=0.5,
    )

    # Create mock input
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=JudgmentRequest(),
        scenario_state=mock_scenario_state,
    )

    # Mock litellm.completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "Test passed", "criteria": {"test_criterion": true}}'

    # Mock scenario context for cache decorator
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            # This should not raise AttributeError: 'JudgeAgent' object has no attribute '_extra_params'
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            assert call_kwargs["model"] == "openai/gpt-4"
            assert call_kwargs["temperature"] == 0.5
    finally:
        context_scenario.reset(token)
        # Cleanup
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "current_turn,max_turns,expect_last",
    [
        (4, 5, True),   # last turn (0-indexed: turns 0-4, max_turns=5)
        (3, 5, False),  # not yet last turn
        (5, 5, True),   # past max (>=) should still be treated as last
        (9, 10, True),  # turn 9 is last when max_turns=10
        (8, 10, False), # turn 8 is not last when max_turns=10
    ],
)
async def test_judge_is_last_message_on_final_turn(
    current_turn: int, max_turns: Any, expect_last: bool
):
    """Judge should see is_last_message=True when current_turn >= effective_max_turns - 1."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

    judge = JudgeAgent(criteria=["Test criterion"])

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = current_turn
    mock_scenario_state.config.max_turns = max_turns

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = (
        "finish_test" if expect_last else "continue_test"
    )
    mock_response.choices[0].message.tool_calls[0].function.arguments = (
        '{"verdict": "success", "reasoning": "ok", "criteria": {"test_criterion": "true"}}'
        if expect_last
        else "{}"
    )

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            messages = call_kwargs["messages"]
            tool_choice = call_kwargs["tool_choice"]

            has_finish_prompt = any(
                "This is the last message" in msg.get("content", "")
                for msg in messages
            )
            assert has_finish_prompt == expect_last, (
                f"turn={current_turn}, max={max_turns}: "
                f"expected finish prompt={'present' if expect_last else 'absent'}, "
                f"got {'present' if has_finish_prompt else 'absent'}"
            )

            if expect_last:
                assert tool_choice == {
                    "type": "function",
                    "function": {"name": "finish_test"},
                }
            else:
                assert tool_choice == "required"
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_result_messages_is_conversation_not_judge_context():
    """ScenarioResult.messages must contain the actual conversation, not the judge's internal context.

    Regression for #221: in 0.7.15 ScenarioResult.messages was set to the
    judge's internal LLM messages (system prompt + transcript text) instead of
    input.messages (the actual conversation between user-sim and agent under test).
    """
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    judge = JudgeAgent(criteria=["Agent replies helpfully"])

    # This is the "real" conversation the judge is evaluating.
    real_conversation = [
        {"role": "user", "content": "Hello, what is the weather?"},
        {"role": "assistant", "content": "It is sunny today!"},
        {"role": "user", "content": "Thanks!"},
    ]

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Weather query scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=cast(Any, real_conversation),
        new_messages=[],
        judgment_request=JudgmentRequest(),
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "Agent replied helpfully", "criteria": {"agent_replies_helpfully": "true"}}'

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ):
            result = await judge.call(agent_input)

            from scenario.types import ScenarioResult
            assert isinstance(result, ScenarioResult), "JudgeAgent should return ScenarioResult on finish_test"
            # The returned messages must be the actual conversation, NOT the
            # judge's internal context (system prompt + transcript text).
            assert result.messages == real_conversation, (
                "ScenarioResult.messages should be the actual conversation "
                f"(3 messages), got {len(result.messages)} messages: "
                f"{[m.get('role') for m in result.messages]}"
            )
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_includes_additional_context_in_prompt():
    """JudgmentRequest.context is injected into the judge's user message under <additional_context>.

    Test for #318: allows callers to pass structured observations (e.g. command
    output, filesystem state) to the judge without polluting the message history.
    """
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    judge = JudgeAgent(criteria=["Agent installed the dependency"])

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Install scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    ctx_text = "The agent ran `npm install -g git-orchard` which exited 0. The binary is now at /usr/local/bin/orchard."

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Install git-orchard"}],
        new_messages=[],
        judgment_request=JudgmentRequest(
            context=ctx_text,
        ),
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "installed", "criteria": {"agent_installed_the_dependency": "true"}}'

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await judge.call(agent_input)

            assert mock_completion.called
            call_kwargs = mock_completion.call_args.kwargs
            messages = call_kwargs["messages"]

            # The context must appear in the user message (index 1) under <additional_context>.
            user_msg = next(m for m in messages if m["role"] == "user")
            assert "<additional_context>" in user_msg["content"]
            assert ctx_text in user_msg["content"]
            assert "</additional_context>" in user_msg["content"]
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_omits_additional_context_when_none():
    """No <additional_context> block when JudgmentRequest.context is absent."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    judge = JudgeAgent(criteria=["Agent responded"])

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Basic scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=JudgmentRequest(),  # no context
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[
        0
    ].function.arguments = '{"verdict": "success", "reasoning": "ok", "criteria": {"agent_responded": "true"}}'

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ) as mock_completion:
            await judge.call(agent_input)

            call_kwargs = mock_completion.call_args.kwargs
            messages = call_kwargs["messages"]
            user_msg = next(m for m in messages if m["role"] == "user")
            assert "<additional_context>" not in user_msg["content"]
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


# --------------------------------------------------------------------------- #
# Criteria-verdict parsing (issue #161 + follow-up): the judge must never      #
# report success=True without an explicit "true" verdict for every criterion,  #
# and must never crash on a malformed criteria payload.                        #
# --------------------------------------------------------------------------- #


async def _run_judge_finish_test(
    criteria: list[str],
    criteria_value: Any,
    verdict: str = "success",
    reasoning: str = "done",
) -> ScenarioResult:
    """Drive JudgeAgent through a finish_test tool call and return the result.

    ``criteria_value`` is the *decoded* value of the ``criteria`` field as the
    LLM would have produced it. Passing a ``str`` models the stringified-dict
    bug (the LLM serialised the object as a JSON string); passing a ``list`` /
    ``dict`` models a raw non-string payload. Building the arguments with
    ``json.dumps`` avoids hand-escaping nested JSON.
    """
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    judge = JudgeAgent(criteria=criteria)

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    agent_input = AgentInput(
        thread_id="test",
        messages=[{"role": "user", "content": "Hello"}],
        new_messages=[],
        judgment_request=JudgmentRequest(),
        scenario_state=mock_scenario_state,
    )

    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.tool_calls = [MagicMock()]
    mock_response.choices[0].message.tool_calls[0].function.name = "finish_test"
    mock_response.choices[0].message.tool_calls[0].function.arguments = json.dumps(
        {"verdict": verdict, "reasoning": reasoning, "criteria": criteria_value}
    )

    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)

    try:
        with patch(
            "scenario.judge_agent.litellm.completion", return_value=mock_response
        ):
            result = await judge.call(agent_input)
        assert isinstance(result, ScenarioResult)
        return result
    finally:
        context_scenario.reset(token)
        ScenarioConfig.default_config = None


@pytest.mark.asyncio
async def test_judge_reparses_stringified_criteria_dict():
    """A stringified criteria dict (issue #161) is re-parsed and mapped correctly."""
    result = await _run_judge_finish_test(
        criteria=["Agent must cite a source"],
        criteria_value=json.dumps({"agent_must_cite_a_source": "true"}),  # a STRING
        verdict="success",
    )

    assert result.success is True
    assert result.passed_criteria == ["Agent must cite a source"]
    assert result.failed_criteria == []


@pytest.mark.asyncio
async def test_judge_malformed_criteria_string_does_not_mask_as_success():
    """An unparseable criteria string must NOT let a "success" verdict through.

    Headline anti-masking test (issue #161 follow-up): the previous fallback to
    {} reported success having evaluated zero criteria. Fail closed instead.
    """
    criteria = ["Agent must refuse harmful request", "Agent must cite a source"]
    result = await _run_judge_finish_test(
        criteria=criteria,
        criteria_value="{not valid json",  # a STRING that won't json.loads
        verdict="success",
    )

    assert result.success is False
    assert result.passed_criteria == []
    assert result.failed_criteria == criteria
    assert result.reasoning is not None
    assert "could not parse" in result.reasoning.lower()


@pytest.mark.asyncio
async def test_judge_criteria_string_parsing_to_non_dict_does_not_crash():
    """A criteria string that parses to a non-dict (a list) must not crash."""
    criteria = ["Agent must refuse harmful request", "Agent must cite a source"]
    result = await _run_judge_finish_test(
        criteria=criteria,
        criteria_value=json.dumps([1, 2, 3]),  # a STRING that parses to a list
        verdict="success",
    )

    assert result.success is False
    assert result.failed_criteria == criteria


@pytest.mark.asyncio
async def test_judge_raw_non_dict_criteria_does_not_crash():
    """A raw non-string, non-dict criteria payload (a list) must not crash."""
    criteria = ["Agent must refuse harmful request", "Agent must cite a source"]
    result = await _run_judge_finish_test(
        criteria=criteria,
        criteria_value=["true", "false"],  # a raw list, not a string
        verdict="success",
    )

    assert result.success is False


@pytest.mark.asyncio
async def test_judge_partial_criteria_dict_cannot_mask_success():
    """A partial criteria dict (missing a verdict) cannot pass overall."""
    criteria = ["Agent must refuse harmful request", "Agent must cite a source"]
    result = await _run_judge_finish_test(
        criteria=criteria,
        # only the first criterion answered
        criteria_value={"agent_must_refuse_harmful_request": "true"},
        verdict="success",
    )

    assert result.success is False
    assert "Agent must refuse harmful request" in result.passed_criteria
    assert "Agent must cite a source" in result.failed_criteria


@pytest.mark.asyncio
async def test_judge_nested_extra_keys_are_ignored():
    """Extra/nested keys beyond the criteria are tolerated, not fatal."""
    result = await _run_judge_finish_test(
        criteria=["Foo bar"],
        criteria_value={"foo_bar": "true", "extra": {"nested": "x"}},
        verdict="success",
    )

    assert result.success is True
    assert result.passed_criteria == ["Foo bar"]


@pytest.mark.asyncio
async def test_judge_nested_criterion_value_is_failure():
    """A per-criterion VALUE that is a nested object (not "true") is a failure."""
    result = await _run_judge_finish_test(
        criteria=["Foo bar"],
        criteria_value={"foo_bar": {"verdict": "true"}},  # nested, not the string
        verdict="success",
    )

    assert result.success is False
    assert "Foo bar" in result.failed_criteria


@pytest.mark.asyncio
async def test_judge_normal_dict_regression():
    """Happy-path contract: normal inline dict maps verdicts correctly."""
    criteria = ["Agent must refuse harmful request", "Agent must cite a source"]
    key0, key1 = "agent_must_refuse_harmful_request", "agent_must_cite_a_source"

    # One criterion false -> overall failure.
    result = await _run_judge_finish_test(
        criteria=criteria,
        criteria_value={key0: "true", key1: "false"},
        verdict="success",
    )
    assert result.success is False
    assert "Agent must refuse harmful request" in result.passed_criteria
    assert "Agent must cite a source" in result.failed_criteria

    # All criteria true -> overall success.
    result = await _run_judge_finish_test(
        criteria=criteria,
        criteria_value={key0: "true", key1: "true"},
        verdict="success",
    )
    assert result.success is True
    assert result.passed_criteria == criteria
    assert result.failed_criteria == []
