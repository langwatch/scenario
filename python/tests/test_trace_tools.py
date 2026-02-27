"""Tests for trace_tools module (expand_trace and grep_trace)."""

from unittest.mock import MagicMock

from opentelemetry.trace import StatusCode

from scenario._judge.trace_tools import expand_trace, grep_trace

from tests.helpers.create_span import create_mock_span


def build_span_set():
    """Builds a representative set of spans for testing."""
    event = MagicMock()
    event.name = "token.generated"
    event.attributes = {"token": "The", "index": 0}

    return [
        create_mock_span(
            span_id=100,
            name="agent.run",
            start_time=1700000000_000_000_000,
            end_time=1700000002_000_000_000,
            attributes={"agent.type": "rag"},
        ),
        create_mock_span(
            span_id=101,
            name="llm.call",
            parent_span_id=100,
            start_time=1700000000_100_000_000,
            end_time=1700000000_500_000_000,
            attributes={
                "gen_ai.prompt": "What is the weather in Paris?",
                "gen_ai.completion": "Let me check the weather for you.",
                "model": "gpt-4",
            },
        ),
        create_mock_span(
            span_id=102,
            name="tool.fetch_report",
            parent_span_id=100,
            start_time=1700000000_600_000_000,
            end_time=1700000000_900_000_000,
            attributes={
                "tool.name": "fetch_report",
                "tool.input": '{"city": "Paris"}',
                "tool.output": '{"temp": 22, "condition": "sunny"}',
            },
        ),
        create_mock_span(
            span_id=103,
            name="llm.completion",
            parent_span_id=100,
            start_time=1700000001_000_000_000,
            end_time=1700000001_500_000_000,
            attributes={
                "gen_ai.prompt": "Summarize the weather report",
                "gen_ai.completion": "The weather in Paris is sunny with a temperature of 22 degrees.",
            },
            events=[event],
        ),
        create_mock_span(
            span_id=104,
            name="failed.operation",
            parent_span_id=100,
            start_time=1700000001_600_000_000,
            end_time=1700000001_700_000_000,
            status_code=StatusCode.ERROR,
            status_description="Connection refused",
            attributes={"error.type": "NetworkError"},
        ),
    ]


# ─── expand_trace tests ──────────────────────────────────────────────


class TestExpandTraceValidIndex:
    """Tests for expand_trace with valid single span index."""

    def test_returns_full_span_details_with_all_attributes(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=2)

        assert "llm.call" in result
        assert "gen_ai.prompt" in result
        assert "What is the weather in Paris?" in result
        assert "gen_ai.completion" in result
        assert "gpt-4" in result

    def test_shows_span_position_in_hierarchy(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=2)

        assert "[2]" in result
        assert "llm.call" in result


class TestExpandTraceRange:
    """Tests for expand_trace with a range of spans."""

    def test_returns_full_details_for_spans_in_range(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, range_str="2-3")

        assert "llm.call" in result
        assert "tool.fetch_report" in result
        assert "gen_ai.prompt" in result
        assert "fetch_report" in result


class TestExpandTraceInvalidIndex:
    """Tests for expand_trace with invalid span index."""

    def test_returns_error_with_valid_range_for_out_of_bounds(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=99)

        assert "out of range" in result
        assert "1" in result
        assert "5" in result

    def test_returns_error_for_index_zero(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=0)

        assert "out of range" in result

    def test_returns_error_for_negative_index(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=-1)

        assert "out of range" in result


class TestExpandTraceEvents:
    """Tests for expand_trace including events."""

    def test_includes_events_in_expanded_output(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=4)

        assert "token.generated" in result
        assert "token: The" in result


class TestExpandTraceError:
    """Tests for expand_trace with error spans."""

    def test_includes_error_indicator(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, index=5)

        assert "ERROR" in result
        assert "Connection refused" in result


class TestExpandTraceEmpty:
    """Tests for expand_trace with empty spans."""

    def test_returns_no_spans_message(self) -> None:
        result = expand_trace([], index=1)
        assert result == "No spans recorded."


class TestExpandTraceNoParams:
    """Tests for expand_trace without index or range."""

    def test_returns_error_message(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans)

        assert "Error" in result


class TestExpandTraceTruncation:
    """Tests for expand_trace truncation when result exceeds token budget."""

    def test_truncates_massive_content_and_adds_note(self) -> None:
        big_span = create_mock_span(
            span_id=1,
            name="big.span",
            start_time=1700000000_000_000_000,
            end_time=1700000001_000_000_000,
            attributes={"massive.content": "x" * 20000},
        )
        result = expand_trace([big_span], index=1)

        # 4096 tokens * 4 chars = 16384 chars max + some slack for truncation note
        assert len(result) <= 17000
        assert "[TRUNCATED]" in result


# ─── grep_trace tests ────────────────────────────────────────────────


class TestGrepTraceMatching:
    """Tests for grep_trace matching span attributes."""

    def test_returns_matching_spans_with_tree_position_headers(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "fetch_report")

        assert "fetch_report" in result
        assert "[3]" in result
        assert "tool.fetch_report" in result


class TestGrepTraceMultipleMatches:
    """Tests for grep_trace matching content in multiple spans."""

    def test_returns_all_matching_spans(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "weather")

        assert "llm.call" in result
        assert "llm.completion" in result


class TestGrepTraceCaseInsensitive:
    """Tests for grep_trace case-insensitive matching."""

    def test_finds_matches_regardless_of_case(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "FETCH_REPORT")

        assert "fetch_report" in result


class TestGrepTraceNoMatches:
    """Tests for grep_trace with no matches."""

    def test_returns_no_match_message_with_suggestions(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "nonexistent_xyz_pattern")

        assert "No matches found" in result
        assert "agent.run" in result


class TestGrepTraceMaxMatches:
    """Tests for grep_trace limiting to 20 matches."""

    def test_limits_to_first_20_matches_and_indicates_more(self) -> None:
        many_spans = [
            create_mock_span(
                span_id=i,
                name=f"operation-{i}",
                start_time=1700000000_000_000_000 + i * 1_000_000_000,
                end_time=1700000000_000_000_000 + i * 1_000_000_000 + 100_000_000,
                attributes={"common.attr": "matching_value"},
            )
            for i in range(30)
        ]
        result = grep_trace(many_spans, "matching_value")

        # Count span headers
        import re
        match_headers = re.findall(r"\[\d+\]", result)
        assert len(match_headers) <= 20
        assert "more match" in result


class TestGrepTraceTruncation:
    """Tests for grep_trace truncation when result exceeds token budget."""

    def test_truncates_total_output_to_approximately_4096_tokens(self) -> None:
        big_spans = [
            create_mock_span(
                span_id=i,
                name=f"operation-{i}",
                start_time=1700000000_000_000_000 + i * 1_000_000_000,
                end_time=1700000000_000_000_000 + i * 1_000_000_000 + 100_000_000,
                attributes={"big.content": "match_" + "x" * 3000},
            )
            for i in range(10)
        ]
        result = grep_trace(big_spans, "match_")

        # 4096 tokens * 4 chars = 16384 max
        assert len(result) <= 17000


class TestGrepTraceEvents:
    """Tests for grep_trace matching span events."""

    def test_finds_matches_in_event_names_and_attributes(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "token.generated")

        assert "llm.completion" in result
        assert "token.generated" in result


class TestGrepTraceEmpty:
    """Tests for grep_trace with empty spans."""

    def test_returns_no_spans_message(self) -> None:
        result = grep_trace([], "anything")
        assert result == "No spans recorded."
