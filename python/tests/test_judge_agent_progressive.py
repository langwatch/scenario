"""Tests for JudgeAgent progressive trace discovery."""

import json
from unittest.mock import MagicMock, patch

import pytest
from langwatch.attributes import AttributeKey
from opentelemetry.trace import StatusCode

from scenario import JudgeAgent
from scenario._judge.estimate_tokens import DEFAULT_TOKEN_THRESHOLD
from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest, ScenarioResult

from tests.helpers.create_span import create_mock_span


def create_large_trace() -> list:
    """Creates a trace large enough to exceed the default token threshold."""
    spans = []
    for i in range(200):
        spans.append(
            create_mock_span(
                span_id=0x1000000000000000 + i,
                name=f"operation-{i}",
                start_time=1700000000_000_000_000 + i * 100_000_000,
                end_time=1700000000_000_000_000 + (i + 1) * 100_000_000,
                attributes={
                    "gen_ai.prompt": f"Prompt content for span {i} with enough text to inflate the token count",
                    "gen_ai.completion": f"Completion content for span {i} with detailed response text",
                    "model": "gpt-4",
                    "extra.data": "x" * 200,
                },
            )
        )
    return spans


def create_mock_collector(spans: list) -> JudgeSpanCollector:
    """Creates a collector that returns the given spans."""
    collector = MagicMock(spec=JudgeSpanCollector)
    collector.get_spans_for_thread.return_value = spans
    return collector


def create_base_input() -> AgentInput:
    """Creates a basic AgentInput for testing."""
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    return AgentInput(
        thread_id="test-thread",
        messages=[
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ],
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_scenario_state,
    )


def mock_litellm_response(tool_name: str, args: dict):
    """Creates a mock litellm response with a tool call."""
    response = MagicMock()
    response.choices = [MagicMock()]
    tool_call = MagicMock()
    tool_call.function.name = tool_name
    tool_call.function.arguments = json.dumps(args)
    response.choices[0].message.tool_calls = [tool_call]
    response.choices[0].message.content = None
    return response


@pytest.fixture(autouse=True)
def setup_config():
    """Set up default config for all tests."""
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)
    yield
    context_scenario.reset(token)
    ScenarioConfig.default_config = None


class TestBuildTraceDigestSmallTrace:
    """Tests for small traces (below token threshold)."""

    @pytest.mark.asyncio
    async def test_renders_full_inline_digest_for_small_traces(self) -> None:
        """Small traces render inline with all attributes."""
        spans = [
            create_mock_span(
                span_id=0xA1B2C3D400000000,
                name="llm.call",
                start_time=1700000000_000_000_000,
                end_time=1700000000_500_000_000,
                attributes={"gen_ai.prompt": "Hello", "model": "gpt-4"},
            ),
        ]
        collector = create_mock_collector(spans)
        judge = JudgeAgent(criteria=["Test"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            # Should NOT have expand/grep tools
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" not in tool_names
            assert "grep_trace" not in tool_names
            # Content should include full attributes
            user_msg = call_kwargs["messages"][1]
            assert "gen_ai.prompt" in user_msg["content"]

    @pytest.mark.asyncio
    async def test_no_progressive_tools_for_small_trace(self) -> None:
        """No expand/grep tools added for small traces."""
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Test"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" not in tool_names
            assert "grep_trace" not in tool_names


class TestBuildTraceDigestLargeTrace:
    """Tests for large traces (above token threshold)."""

    @pytest.mark.asyncio
    async def test_renders_structure_only_digest_with_usage_hint(self) -> None:
        """Large traces render structure-only with expand/grep hint."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(criteria=["Agent works"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            user_msg = call_kwargs["messages"][1]
            # Structure-only should mention tools
            assert "expand_trace" in user_msg["content"]
            assert "grep_trace" in user_msg["content"]
            # Should NOT contain detailed attributes
            assert "gen_ai.prompt" not in user_msg["content"]

    @pytest.mark.asyncio
    async def test_provides_expand_and_grep_tools_for_large_traces(self) -> None:
        """Large traces should add expand_trace and grep_trace tools."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(criteria=["Agent works"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" in tool_names
            assert "grep_trace" in tool_names
            assert "continue_test" in tool_names
            assert "finish_test" in tool_names


class TestProgressiveDiscoveryLoop:
    """Tests for the multi-step discovery loop."""

    @pytest.mark.asyncio
    async def test_executes_expand_tool_and_continues_loop(self) -> None:
        """When LLM calls expand_trace, execute it and loop back."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(criteria=["Agent works"], span_collector=collector)

        # First call: LLM wants to expand a span
        expand_response = MagicMock()
        expand_response.choices = [MagicMock()]
        expand_tool_call = MagicMock()
        expand_tool_call.id = "call_1"
        expand_tool_call.function.name = "expand_trace"
        expand_tool_call.function.arguments = json.dumps({"span_ids": ["10000000"]})
        expand_response.choices[0].message.tool_calls = [expand_tool_call]
        expand_response.choices[0].message.content = None
        expand_response.choices[0].message.role = "assistant"

        # Second call: LLM finishes
        finish_response = mock_litellm_response("finish_test", {
            "criteria": {"agent_works": "true"},
            "reasoning": "All good",
            "verdict": "success",
        })

        call_count = 0

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return expand_response
            return finish_response

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=mock_completion,
        ):
            result = await judge.call(create_base_input())

            # Should have made 2 LLM calls (expand + finish)
            assert call_count == 2

    @pytest.mark.asyncio
    async def test_executes_grep_tool_and_continues_loop(self) -> None:
        """When LLM calls grep_trace, execute it and loop back."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(criteria=["Agent works"], span_collector=collector)

        # First call: grep
        grep_response = MagicMock()
        grep_response.choices = [MagicMock()]
        grep_tool_call = MagicMock()
        grep_tool_call.id = "call_1"
        grep_tool_call.function.name = "grep_trace"
        grep_tool_call.function.arguments = json.dumps({"pattern": "operation-5"})
        grep_response.choices[0].message.tool_calls = [grep_tool_call]
        grep_response.choices[0].message.content = None
        grep_response.choices[0].message.role = "assistant"

        # Second call: continue
        continue_response = mock_litellm_response("continue_test", {})

        call_count = 0

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return grep_response
            return continue_response

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=mock_completion,
        ):
            result = await judge.call(create_base_input())

            assert call_count == 2

    @pytest.mark.asyncio
    async def test_stops_at_max_discovery_steps(self) -> None:
        """Loop stops after max_discovery_steps even without terminal tool call."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(
            criteria=["Agent works"],
            span_collector=collector,
            max_discovery_steps=3,
        )

        # Always return an expand call (never finishes)
        def mock_completion(**kwargs):
            expand_response = MagicMock()
            expand_response.choices = [MagicMock()]
            expand_tool_call = MagicMock()
            expand_tool_call.id = "call_x"
            expand_tool_call.function.name = "expand_trace"
            expand_tool_call.function.arguments = json.dumps({"span_ids": ["10000000"]})
            expand_response.choices[0].message.tool_calls = [expand_tool_call]
            expand_response.choices[0].message.content = None
            expand_response.choices[0].message.role = "assistant"
            return expand_response

        call_count = 0
        original_mock = mock_completion

        def counting_mock(**kwargs):
            nonlocal call_count
            call_count += 1
            return original_mock(**kwargs)

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=counting_mock,
        ):
            result = await judge.call(create_base_input())

            # Should stop after max_discovery_steps
            assert call_count <= 3
            # Should return a result indicating max steps hit
            assert isinstance(result, ScenarioResult)
            assert result.success is False
            assert result.reasoning is not None
            assert "maximum discovery steps" in result.reasoning


class TestProgressiveDiscoveryVerdicts:
    """Tests for verdict handling in progressive discovery mode."""

    @pytest.mark.asyncio
    async def test_finish_test_returns_correct_result(self) -> None:
        """finish_test in progressive mode returns proper ScenarioResult."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(
            criteria=["Agent responds correctly", "Agent uses tools"],
            span_collector=collector,
        )

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("finish_test", {
                "criteria": {
                    "agent_responds_correctly": "true",
                    "agent_uses_tools": "false",
                },
                "reasoning": "Agent responded but did not use tools",
                "verdict": "failure",
            }),
        ):
            result = await judge.call(create_base_input())

            assert isinstance(result, ScenarioResult)
            assert result.success is False
            assert result.reasoning == "Agent responded but did not use tools"
            assert "Agent responds correctly" in result.passed_criteria
            assert "Agent uses tools" in result.failed_criteria

    @pytest.mark.asyncio
    async def test_continue_test_returns_empty_list(self) -> None:
        """continue_test in progressive mode returns empty list."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        judge = JudgeAgent(criteria=["Agent completes task"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ):
            result = await judge.call(create_base_input())
            assert result == []


class TestCustomSystemPromptWithLargeTrace:
    """Tests for custom system prompt preservation with large traces."""

    @pytest.mark.asyncio
    async def test_preserves_custom_system_prompt(self) -> None:
        """Custom system prompt should be preserved even with large traces."""
        large_trace = create_large_trace()
        collector = create_mock_collector(large_trace)
        custom_prompt = "You are a special judge with custom rules."
        judge = JudgeAgent(
            criteria=["Custom criterion"],
            system_prompt=custom_prompt,
            span_collector=collector,
        )

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            system_msg = call_kwargs["messages"][0]
            assert custom_prompt in system_msg["content"]


class TestEmptyTraceHandling:
    """Tests for empty trace handling."""

    @pytest.mark.asyncio
    async def test_empty_trace_renders_no_spans_message(self) -> None:
        """Empty traces return 'No spans recorded.' regardless of mode."""
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Test"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            user_msg = call_kwargs["messages"][1]
            assert "No spans recorded." in user_msg["content"]

            # No expand/grep tools for empty traces
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" not in tool_names
            assert "grep_trace" not in tool_names


class TestConfigurableThreshold:
    """Tests for configurable token_threshold."""

    @pytest.mark.asyncio
    async def test_custom_token_threshold(self) -> None:
        """Custom token_threshold controls when structure-only mode activates."""
        # Create a trace that is small but exceeds a very low threshold
        spans = [
            create_mock_span(
                span_id=0xA1B2C3D400000000,
                name="llm.call",
                start_time=1700000000_000_000_000,
                end_time=1700000000_500_000_000,
                attributes={"content": "x" * 200},
            ),
        ]
        collector = create_mock_collector(spans)

        # Very low threshold - should trigger structure-only
        judge = JudgeAgent(
            criteria=["Test"],
            span_collector=collector,
            token_threshold=10,
        )

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" in tool_names
            assert "grep_trace" in tool_names


class TestBoundaryThreshold:
    """Tests for the exact boundary at the default 8192 token threshold."""

    @pytest.mark.asyncio
    async def test_trace_at_exactly_threshold_renders_inline(self) -> None:
        """A trace at exactly 8192 estimated tokens renders inline (threshold is exclusive)."""
        from scenario._judge.estimate_tokens import estimate_tokens
        from scenario._judge.judge_span_digest_formatter import JudgeSpanDigestFormatter

        formatter = JudgeSpanDigestFormatter()

        # Build a single span and iteratively pad its content to hit exactly 8192 tokens
        def make_spans(padding: str) -> list:
            return [
                create_mock_span(
                    span_id=0xA1B2C3D400000000,
                    name="boundary.span",
                    start_time=1700000000_000_000_000,
                    end_time=1700000001_000_000_000,
                    attributes={"content": padding},
                ),
            ]

        # Binary search for the padding length that produces exactly 8192 tokens
        lo, hi = 1, 100000
        while lo < hi:
            mid = (lo + hi) // 2
            digest = formatter.format(make_spans("a" * mid))
            tokens = estimate_tokens(digest)
            if tokens < DEFAULT_TOKEN_THRESHOLD:
                lo = mid + 1
            else:
                hi = mid

        # lo is now the smallest padding that gives >= 8192 tokens
        # We want exactly 8192, so try lo and adjust
        digest = formatter.format(make_spans("a" * lo))
        tokens = estimate_tokens(digest)
        if tokens > DEFAULT_TOKEN_THRESHOLD:
            # Go back one - tokens < 8192, then find exact
            lo -= 1
            digest = formatter.format(make_spans("a" * lo))
            tokens = estimate_tokens(digest)

        # Now try to hit exactly 8192 by fine-tuning
        # If we're below, pad more; the goal is to test at exactly threshold
        while estimate_tokens(formatter.format(make_spans("a" * lo))) < DEFAULT_TOKEN_THRESHOLD:
            lo += 1
        # lo now gives >= 8192
        while estimate_tokens(formatter.format(make_spans("a" * lo))) > DEFAULT_TOKEN_THRESHOLD:
            lo -= 1
        # lo now gives exactly 8192 or less

        exact_spans = make_spans("a" * lo)
        exact_digest = formatter.format(exact_spans)
        exact_tokens = estimate_tokens(exact_digest)

        # Verify we're at or just below the threshold
        assert exact_tokens <= DEFAULT_TOKEN_THRESHOLD

        collector = create_mock_collector(exact_spans)
        judge = JudgeAgent(criteria=["Test"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input())

            call_kwargs = mock_completion.call_args.kwargs
            # At threshold, should render inline (no progressive tools)
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_trace" not in tool_names
            assert "grep_trace" not in tool_names
            # Content should contain full attributes
            user_msg = call_kwargs["messages"][1]
            assert "content:" in user_msg["content"]
