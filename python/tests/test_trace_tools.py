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
            span_id=0xA0B1C2D3E4F56789,
            name="agent.run",
            start_time=1700000000_000_000_000,
            end_time=1700000002_000_000_000,
            attributes={"agent.type": "rag"},
        ),
        create_mock_span(
            span_id=0xB1C2D3E4F5678901,
            name="llm.call",
            parent_span_id=0xA0B1C2D3E4F56789,
            start_time=1700000000_100_000_000,
            end_time=1700000000_500_000_000,
            attributes={
                "gen_ai.prompt": "What is the weather in Paris?",
                "gen_ai.completion": "Let me check the weather for you.",
                "model": "gpt-4",
            },
        ),
        create_mock_span(
            span_id=0xC2D3E4F567890123,
            name="tool.fetch_report",
            parent_span_id=0xA0B1C2D3E4F56789,
            start_time=1700000000_600_000_000,
            end_time=1700000000_900_000_000,
            attributes={
                "tool.name": "fetch_report",
                "tool.input": '{"city": "Paris"}',
                "tool.output": '{"temp": 22, "condition": "sunny"}',
            },
        ),
        create_mock_span(
            span_id=0xD3E4F56789012345,
            name="llm.completion",
            parent_span_id=0xA0B1C2D3E4F56789,
            start_time=1700000001_000_000_000,
            end_time=1700000001_500_000_000,
            attributes={
                "gen_ai.prompt": "Summarize the weather report",
                "gen_ai.completion": "The weather in Paris is sunny with a temperature of 22 degrees.",
            },
            events=[event],
        ),
        create_mock_span(
            span_id=0xE4F5678901234567,
            name="failed.operation",
            parent_span_id=0xA0B1C2D3E4F56789,
            start_time=1700000001_600_000_000,
            end_time=1700000001_700_000_000,
            status_code=StatusCode.ERROR,
            status_description="Connection refused",
            attributes={"error.type": "NetworkError"},
        ),
    ]


# ─── expand_trace tests ──────────────────────────────────────────────


class TestExpandTraceValidSpanId:
    """Tests for expand_trace with valid span ID."""

    def test_returns_full_span_details_with_all_attributes(self) -> None:
        spans = build_span_set()
        # b1c2d3e4 is the first 8 hex chars of 0xB1C2D3E4F5678901
        result = expand_trace(spans, span_ids=["b1c2d3e4"])

        assert "llm.call" in result
        assert "gen_ai.prompt" in result
        assert "What is the weather in Paris?" in result
        assert "gen_ai.completion" in result
        assert "gpt-4" in result

    def test_shows_span_id_in_brackets(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=["b1c2d3e4"])

        assert "[b1c2d3e4]" in result
        assert "llm.call" in result


class TestExpandTraceMultipleSpanIds:
    """Tests for expand_trace with multiple span IDs."""

    def test_returns_full_details_for_all_matching_spans(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=["b1c2d3e4", "c2d3e4f5"])

        assert "llm.call" in result
        assert "tool.fetch_report" in result
        assert "gen_ai.prompt" in result
        assert "fetch_report" in result


class TestExpandTraceNonMatchingId:
    """Tests for expand_trace with non-matching span ID."""

    def test_returns_error_with_available_ids(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=["ffffffff"])

        assert "no spans matched" in result
        assert "a0b1c2d3" in result


class TestExpandTraceEvents:
    """Tests for expand_trace including events."""

    def test_includes_events_in_expanded_output(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=["d3e4f567"])

        assert "token.generated" in result
        assert "token: The" in result


class TestExpandTraceError:
    """Tests for expand_trace with error spans."""

    def test_includes_error_indicator(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=["e4f56789"])

        assert "ERROR" in result
        assert "Connection refused" in result


class TestExpandTraceEmpty:
    """Tests for expand_trace with empty spans."""

    def test_returns_no_spans_message(self) -> None:
        result = expand_trace([], span_ids=["anything"])
        assert result == "No spans recorded."


class TestExpandTraceEmptyIds:
    """Tests for expand_trace with empty span_ids list."""

    def test_returns_error_message(self) -> None:
        spans = build_span_set()
        result = expand_trace(spans, span_ids=[])

        assert "Error" in result


class TestExpandTraceTruncation:
    """Tests for expand_trace truncation when result exceeds token budget."""

    def test_truncates_massive_content_and_adds_note(self) -> None:
        big_span = create_mock_span(
            span_id=0xAABB001122334455,
            name="big.span",
            start_time=1700000000_000_000_000,
            end_time=1700000001_000_000_000,
            attributes={"massive.content": "x" * 20000},
        )
        result = expand_trace([big_span], span_ids=["aabb0011"])

        # 4096 tokens * 4 chars = 16384 chars max + some slack for truncation note
        assert len(result) <= 17000
        assert "[TRUNCATED]" in result


class TestExpandTracePrefixMatch:
    """Tests for prefix matching in expand_trace."""

    def test_prefix_matches_multiple_spans(self) -> None:
        spans = [
            create_mock_span(
                span_id=0xAA11BB2200000001,
                name="first.op",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=0xAA11BB2200000002,
                name="second.op",
                start_time=1700000000_200_000_000,
                end_time=1700000000_300_000_000,
            ),
        ]
        result = expand_trace(spans, span_ids=["aa11bb22"])

        assert "first.op" in result
        assert "second.op" in result


# ─── grep_trace tests ────────────────────────────────────────────────


class TestGrepTraceMatching:
    """Tests for grep_trace matching span attributes."""

    def test_returns_matching_spans_with_span_id_headers(self) -> None:
        spans = build_span_set()
        result = grep_trace(spans, "fetch_report")

        assert "fetch_report" in result
        assert "[c2d3e4f5]" in result
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
                span_id=0x1000000000000000 + i,
                name=f"operation-{i}",
                start_time=1700000000_000_000_000 + i * 1_000_000_000,
                end_time=1700000000_000_000_000 + i * 1_000_000_000 + 100_000_000,
                attributes={"common.attr": "matching_value"},
            )
            for i in range(30)
        ]
        result = grep_trace(many_spans, "matching_value")

        # Count span headers (8-char hex IDs in brackets)
        import re
        match_headers = re.findall(r"\[[0-9a-f]{8}\]", result)
        assert len(match_headers) <= 20
        assert "more match" in result


class TestGrepTraceTruncation:
    """Tests for grep_trace truncation when result exceeds token budget."""

    def test_truncates_total_output_to_approximately_4096_tokens(self) -> None:
        big_spans = [
            create_mock_span(
                span_id=0x2000000000000000 + i,
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
