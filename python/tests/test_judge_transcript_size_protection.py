"""Regression tests for issue #836.

JudgeAgent's trace-size protection (structure-only digest + expand_trace/
grep_trace discovery) was gated entirely on `spans`, which only ever
contains spans from `autotrack_litellm_calls`. An AgentAdapter that talks to
its own backend directly (REST/SSE/gRPC/etc., not via litellm) produces
tool-call messages that never become spans, so `is_large_trace` never
tripped for such agents and the raw `transcript` block — built from
`input.messages` with no cap of any kind other than base64 stripping — was
sent to the judge unbounded. Large transcripts could then silently get
"lost in the middle" for a small/cheap judge model, producing a confident
but wrong verdict instead of an error.

These tests build a large *transcript* (many tool-call/tool-result
messages) while keeping `spans` empty, simulating exactly that non-litellm
agent adapter.
"""

import json
from typing import Any, cast
from unittest.mock import MagicMock, patch

import pytest

from scenario import JudgeAgent
from scenario._judge.estimate_tokens import DEFAULT_TOKEN_THRESHOLD, estimate_tokens
from scenario._judge.transcript_tools import build_transcript_skeleton, expand_transcript
from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput


def create_mock_collector(spans: list) -> JudgeSpanCollector:
    collector = MagicMock(spec=JudgeSpanCollector)
    collector.get_spans_for_thread.return_value = spans
    return collector


def create_large_non_litellm_transcript() -> list:
    """Simulates a non-litellm agent: 27 tool calls with large SQL-like
    result payloads, mirroring the reporter's real repro. None of this
    ever became a span, since the agent doesn't route through litellm.
    """
    messages: list = [
        {"role": "user", "content": "Please pull the Q3 sales report."},
    ]
    for i in range(27):
        call_id = f"call_{i}"
        messages.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": "run_sql",
                            "arguments": json.dumps({"query": f"SELECT * FROM sales_{i}"}),
                        },
                    }
                ],
            }
        )
        # ~2500 chars per result, 27 of them -> well over the 32KB
        # (8192 tokens * 4 chars) transcript threshold.
        big_row = ",".join(f"row_{i}_{j}=value_{j}" for j in range(100))
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": f"[{big_row}]",
            }
        )
    return messages


def create_base_input(messages: list) -> AgentInput:
    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Test scenario"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 10

    return AgentInput(
        thread_id="test-thread",
        messages=messages,
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_scenario_state,
    )


def mock_litellm_response(tool_name: str, args: dict):
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
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)
    yield
    context_scenario.reset(token)
    ScenarioConfig.default_config = None


class TestNonLitellmAgentGetsTranscriptProtection:
    """The core #836 repro: empty spans, huge transcript."""

    @pytest.mark.asyncio
    async def test_large_transcript_with_no_spans_still_triggers_discovery(self) -> None:
        """Before the fix: spans=[] kept is_large_trace False forever, so no
        expand/grep tools were ever offered and the raw transcript went out
        unbounded. After the fix: transcript size alone must be able to
        trigger structure-only rendering + discovery tools.
        """
        messages = create_large_non_litellm_transcript()
        collector = create_mock_collector([])  # no spans: not a litellm agent
        judge = JudgeAgent(criteria=["Agent verified the sales data"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input(messages))

            call_kwargs = mock_completion.call_args.kwargs
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_transcript" in tool_names
            assert "grep_transcript" in tool_names

    @pytest.mark.asyncio
    async def test_large_transcript_is_not_sent_unbounded(self) -> None:
        """The full 60-row-per-call SQL payloads must NOT appear verbatim in
        the prompt sent to the judge once the transcript is large — that's
        exactly the unbounded flow the issue describes.
        """
        messages = create_large_non_litellm_transcript()
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Agent verified the sales data"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input(messages))

            call_kwargs = mock_completion.call_args.kwargs
            user_msg = call_kwargs["messages"][1]["content"]
            # A marker only present inside one of the large SQL rows.
            assert "row_13_30=value_30" not in user_msg
            # But the structure-only skeleton should still mention the tool.
            assert "run_sql" in user_msg

    @pytest.mark.asyncio
    async def test_expand_transcript_recovers_full_content(self) -> None:
        """The judge can still reach the full content via expand_transcript,
        so nothing is permanently lost -- it's just no longer force-fed
        unbounded on every call.
        """
        messages = create_large_non_litellm_transcript()
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Agent verified the sales data"], span_collector=collector)

        expand_response = MagicMock()
        expand_response.choices = [MagicMock()]
        expand_tool_call = MagicMock()
        expand_tool_call.id = "call_x"
        expand_tool_call.function.name = "expand_transcript"
        # Index 2 is the first "tool" result message (index 0 = user,
        # index 1 = assistant tool_call, index 2 = tool result).
        expand_tool_call.function.arguments = json.dumps({"indices": [2]})
        expand_response.choices[0].message.tool_calls = [expand_tool_call]
        expand_response.choices[0].message.content = None
        expand_response.choices[0].message.role = "assistant"

        finish_response = mock_litellm_response(
            "finish_test",
            {
                "criteria": {"agent_verified_the_sales_data": "true"},
                "reasoning": "Verified via expanded tool result",
                "verdict": "success",
            },
        )

        call_count = 0
        captured_tool_message = {}

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return expand_response
            # Capture what the discovery tool actually returned.
            for m in kwargs["messages"]:
                if m.get("tool_call_id") == "call_x":
                    captured_tool_message["content"] = m["content"]
            return finish_response

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=mock_completion,
        ):
            await judge.call(create_base_input(messages))

            assert call_count == 2
            assert "row_0_" in captured_tool_message["content"]

    @pytest.mark.asyncio
    async def test_small_transcript_unaffected(self) -> None:
        """A normal, small transcript should render in full with no
        discovery tools -- unchanged behavior for the common case.
        """
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Agent greets the user"], span_collector=collector)

        with patch(
            "scenario.judge_agent.litellm.completion",
            return_value=mock_litellm_response("continue_test", {}),
        ) as mock_completion:
            await judge.call(create_base_input(messages))

            call_kwargs = mock_completion.call_args.kwargs
            tool_names = [t["function"]["name"] for t in call_kwargs["tools"]]
            assert "expand_transcript" not in tool_names
            assert "grep_transcript" not in tool_names
            user_msg = call_kwargs["messages"][1]["content"]
            assert "Hi there!" in user_msg


class TestGrepTranscriptTool:
    @pytest.mark.asyncio
    async def test_grep_transcript_finds_matching_message(self) -> None:
        messages = create_large_non_litellm_transcript()
        collector = create_mock_collector([])
        judge = JudgeAgent(criteria=["Agent verified the sales data"], span_collector=collector)

        grep_response = MagicMock()
        grep_response.choices = [MagicMock()]
        grep_tool_call = MagicMock()
        grep_tool_call.id = "call_g"
        grep_tool_call.function.name = "grep_transcript"
        grep_tool_call.function.arguments = json.dumps({"pattern": "sales_13"})
        grep_response.choices[0].message.tool_calls = [grep_tool_call]
        grep_response.choices[0].message.content = None
        grep_response.choices[0].message.role = "assistant"

        continue_response = mock_litellm_response("continue_test", {})

        call_count = 0
        captured = {}

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return grep_response
            for m in kwargs["messages"]:
                if m.get("tool_call_id") == "call_g":
                    captured["content"] = m["content"]
            return continue_response

        with patch(
            "scenario.judge_agent.litellm.completion",
            side_effect=mock_completion,
        ):
            await judge.call(create_base_input(messages))

            assert call_count == 2
            assert "sales_13" in captured["content"]


class TestExpandTranscriptMalformedIndices:
    """expand_transcript is reachable from an LLM tool call, so a
    misbehaving/lax provider (not every litellm-routed model enforces
    function-call argument types as strictly as OpenAI) sending non-integer
    array entries must not crash the discovery loop.
    """

    def test_non_integer_indices_do_not_raise(self) -> None:
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        # Should not raise TypeError from sorting a mixed-type set. Args are
        # deliberately malformed (as if a lax provider ignored the schema),
        # hence the cast past expand_transcript's List[int] signature.
        result = expand_transcript(cast(Any, messages), indices=cast(Any, ["1", 5]))
        assert "[1] assistant" in result
        assert "Ignored out-of-range indices: [5]" in result

    def test_unparseable_indices_are_reported_not_raised(self) -> None:
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        result = expand_transcript(
            cast(Any, messages), indices=cast(Any, [None, {}, "1"])
        )
        assert "[1] assistant" in result
        assert "Ignored non-integer indices" in result


class TestSkeletonItselfIsBounded:
    """The skeleton exists to keep the judge prompt bounded, so it must
    bound itself: a transcript with thousands of tiny messages (e.g. a
    streaming/high-frequency tool-call agent) has a tiny per-message cost
    but can still produce a skeleton that blows past the same threshold
    that triggered structure-only rendering in the first place.
    """

    def test_many_tiny_messages_still_produce_a_bounded_skeleton(self) -> None:
        messages = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"}
            for i in range(5000)
        ]
        skeleton = build_transcript_skeleton(cast(Any, messages))
        assert estimate_tokens(skeleton) <= DEFAULT_TOKEN_THRESHOLD

    def test_bounded_skeleton_keeps_head_and_tail(self) -> None:
        messages = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"}
            for i in range(5000)
        ]
        skeleton = build_transcript_skeleton(cast(Any, messages))
        assert "[0] user" in skeleton
        assert "[4999] assistant" in skeleton
        assert "omitted" in skeleton

    def test_small_message_count_is_unaffected(self) -> None:
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        skeleton = build_transcript_skeleton(cast(Any, messages))
        assert "omitted" not in skeleton
        assert "[0] user" in skeleton
        assert "[1] assistant" in skeleton
