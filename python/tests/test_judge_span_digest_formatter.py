"""Tests for JudgeSpanDigestFormatter."""

from typing import Any, cast
from unittest.mock import MagicMock

import pytest
from langwatch.attributes import AttributeKey
from opentelemetry.trace import StatusCode

from scenario._judge.judge_span_digest_formatter import JudgeSpanDigestFormatter


def create_mock_span(
    *,
    span_id: int,
    name: str,
    start_time: int,
    end_time: int,
    parent_span_id: int | None = None,
    attributes: dict | None = None,
    events: list | None = None,
    status_code: StatusCode = StatusCode.OK,
    status_description: str | None = None,
) -> MagicMock:
    """Creates a mock ReadableSpan for testing."""
    span = MagicMock()
    span.name = name
    span.start_time = start_time
    span.end_time = end_time
    span.get_span_context.return_value.span_id = span_id
    span.attributes = attributes or {}
    span.events = events or []
    span.status.status_code = status_code
    span.status.description = status_description

    if parent_span_id is not None:
        span.parent = MagicMock()
        span.parent.span_id = parent_span_id
    else:
        span.parent = None

    return span


class TestJudgeSpanDigestFormatterEmpty:
    """Tests for empty spans case."""

    def test_returns_empty_marker_when_no_spans(self) -> None:
        """Should return empty digest marker when no spans."""
        formatter = JudgeSpanDigestFormatter()
        result = formatter.format([])
        assert result == "No spans recorded."


class TestJudgeSpanDigestFormatterSingleSpan:
    """Tests for single span formatting."""

    def test_includes_span_name_and_duration(self) -> None:
        """Should include span name and duration."""
        formatter = JudgeSpanDigestFormatter()
        # 100ms duration (in nanoseconds)
        span = create_mock_span(
            span_id=1,
            name="llm.chat",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
        )

        result = formatter.format([span])

        assert "llm.chat" in result
        assert "100ms" in result
        assert "Spans: 1" in result

    def test_includes_attributes(self) -> None:
        """Should include span attributes."""
        formatter = JudgeSpanDigestFormatter()
        span = create_mock_span(
            span_id=1,
            name="test",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
            attributes={
                "gen_ai.prompt": "Hello",
                "gen_ai.completion": "Hi there!",
                "model": "gpt-4",
            },
        )

        result = formatter.format([span])

        assert "gen_ai.prompt: Hello" in result
        assert "gen_ai.completion: Hi there!" in result
        assert "model: gpt-4" in result


class TestJudgeSpanDigestFormatterMultipleSpans:
    """Tests for multiple spans formatting."""

    def test_orders_spans_by_start_time(self) -> None:
        """Should order spans by start time."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=2,
                name="second",
                start_time=1700000001_000_000_000,
                end_time=1700000001_100_000_000,
            ),
            create_mock_span(
                span_id=1,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
        ]

        result = formatter.format(spans)

        first_idx = result.index("first")
        second_idx = result.index("second")
        assert first_idx < second_idx

    def test_assigns_sequence_numbers(self) -> None:
        """Should assign sequence numbers to spans."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=1,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=2,
                name="second",
                start_time=1700000001_000_000_000,
                end_time=1700000001_100_000_000,
            ),
        ]

        result = formatter.format(spans)

        assert "[1]" in result
        assert "[2]" in result


class TestJudgeSpanDigestFormatterHierarchy:
    """Tests for parent-child span hierarchy."""

    def test_nests_children_under_parent(self) -> None:
        """Should nest child spans under parent."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=1,
                name="parent",
                start_time=1700000000_000_000_000,
                end_time=1700000001_000_000_000,
            ),
            create_mock_span(
                span_id=2,
                name="child",
                parent_span_id=1,
                start_time=1700000000_100_000_000,
                end_time=1700000000_500_000_000,
            ),
        ]

        result = formatter.format(spans)

        # Child should appear after parent with tree prefix
        parent_idx = result.index("parent")
        child_idx = result.index("child")
        assert parent_idx < child_idx
        # Should have tree drawing characters
        assert "├──" in result or "└──" in result


class TestJudgeSpanDigestFormatterErrors:
    """Tests for error span formatting."""

    def test_marks_error_spans(self) -> None:
        """Should mark spans with error status."""
        formatter = JudgeSpanDigestFormatter()
        span = create_mock_span(
            span_id=1,
            name="failed.operation",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
            status_code=StatusCode.ERROR,
            status_description="Connection refused",
        )

        result = formatter.format([span])

        assert "ERROR" in result
        assert "Connection refused" in result

    def test_collects_errors_in_summary(self) -> None:
        """Should collect errors in summary section."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=1,
                name="successful",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=2,
                name="failed",
                start_time=1700000000_200_000_000,
                end_time=1700000000_300_000_000,
                status_code=StatusCode.ERROR,
                status_description="Error message",
            ),
        ]

        result = formatter.format(spans)

        assert "=== ERRORS ===" in result
        assert "failed: Error message" in result


class TestJudgeSpanDigestFormatterEvents:
    """Tests for span events formatting."""

    def test_renders_events(self) -> None:
        """Should render span events."""
        formatter = JudgeSpanDigestFormatter()
        event = MagicMock()
        event.name = "token.generated"
        event.attributes = {"token": "Hello", "index": 0}

        span = create_mock_span(
            span_id=1,
            name="llm.stream",
            start_time=1700000000_000_000_000,
            end_time=1700000001_000_000_000,
            events=[event],
        )

        result = formatter.format([span])

        assert "[event] token.generated" in result
        assert "token: Hello" in result


class TestJudgeSpanDigestFormatterFiltering:
    """Tests for attribute filtering."""

    def test_excludes_internal_attributes(self) -> None:
        """Should exclude thread.id, scenario.id, scenario.name."""
        formatter = JudgeSpanDigestFormatter()
        span = create_mock_span(
            span_id=1,
            name="test",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
            attributes={
                AttributeKey.LangWatchThreadId: "thread-123",
                "langwatch.scenario.id": "scenario-456",
                "langwatch.scenario.name": "my-scenario",
                "relevant.attribute": "should-appear",
            },
        )

        result = formatter.format([span])

        assert "thread-123" not in result
        assert "scenario-456" not in result
        assert "my-scenario" not in result
        assert "relevant.attribute: should-appear" in result


class TestJudgeSpanDigestFormatterDeduplication:
    """Tests for string deduplication."""

    def test_deduplicates_long_strings(self) -> None:
        """Should deduplicate long repeated strings."""
        formatter = JudgeSpanDigestFormatter()
        long_content = "This is a long string that exceeds the threshold for deduplication testing purposes."
        spans = [
            create_mock_span(
                span_id=1,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
                attributes={"content": long_content},
            ),
            create_mock_span(
                span_id=2,
                name="second",
                start_time=1700000000_200_000_000,
                end_time=1700000000_300_000_000,
                attributes={"content": long_content},
            ),
        ]

        result = formatter.format(spans)

        assert long_content in result
        assert "[DUPLICATE - SEE ABOVE]" in result

    def test_does_not_deduplicate_short_strings(self) -> None:
        """Should not deduplicate short strings."""
        formatter = JudgeSpanDigestFormatter()
        short_content = "Short"
        spans = [
            create_mock_span(
                span_id=1,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
                attributes={"content": short_content},
            ),
            create_mock_span(
                span_id=2,
                name="second",
                start_time=1700000000_200_000_000,
                end_time=1700000000_300_000_000,
                attributes={"content": short_content},
            ),
        ]

        result = formatter.format(spans)

        # Short content should appear twice
        assert result.count(short_content) == 2
        assert "[DUPLICATE - SEE ABOVE]" not in result

    def test_resets_deduplication_between_calls(self) -> None:
        """Should reset deduplication state between format calls."""
        formatter = JudgeSpanDigestFormatter()
        long_content = (
            "This content appears in both calls but should show fully each time."
        )
        span = create_mock_span(
            span_id=1,
            name="test",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
            attributes={"content": long_content},
        )

        result1 = formatter.format([span])
        result2 = formatter.format([span])

        assert long_content in result1
        assert long_content in result2
        assert "[DUPLICATE - SEE ABOVE]" not in result1
        assert "[DUPLICATE - SEE ABOVE]" not in result2
