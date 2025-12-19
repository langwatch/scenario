"""Tests for JudgeSpanCollector."""

import pytest
from unittest.mock import MagicMock
from langwatch.attributes import AttributeKey
from scenario._tracing.judge_span_collector import JudgeSpanCollector


def create_mock_span(
    *,
    span_id: int,
    name: str,
    parent_span_id: int | None = None,
    attributes: dict | None = None,
) -> MagicMock:
    """Creates a mock ReadableSpan for testing."""
    span = MagicMock()
    span.name = name
    span.get_span_context.return_value.span_id = span_id
    span.attributes = attributes or {}

    if parent_span_id is not None:
        span.parent = MagicMock()
        span.parent.span_id = parent_span_id
    else:
        span.parent = None

    return span


class TestJudgeSpanCollector:
    """Tests for JudgeSpanCollector."""

    def test_on_end_stores_span(self) -> None:
        """on_end should store spans."""
        collector = JudgeSpanCollector()
        span = create_mock_span(span_id=1, name="test")

        collector.on_end(span)

        assert len(collector._spans) == 1
        assert collector._spans[0] == span

    def test_on_start_is_noop(self) -> None:
        """on_start should not store anything."""
        collector = JudgeSpanCollector()
        span = create_mock_span(span_id=1, name="test")

        collector.on_start(span)

        assert len(collector._spans) == 0

    def test_shutdown_clears_spans(self) -> None:
        """shutdown should clear all stored spans."""
        collector = JudgeSpanCollector()
        collector.on_end(create_mock_span(span_id=1, name="span1"))
        collector.on_end(create_mock_span(span_id=2, name="span2"))

        collector.shutdown()

        assert len(collector._spans) == 0

    def test_force_flush_returns_true(self) -> None:
        """force_flush should return True."""
        collector = JudgeSpanCollector()

        result = collector.force_flush()

        assert result is True


class TestGetSpansForThread:
    """Tests for get_spans_for_thread method."""

    def test_returns_spans_with_matching_thread_id(self) -> None:
        """Should return spans that have the matching thread ID."""
        collector = JudgeSpanCollector()
        span1 = create_mock_span(
            span_id=1,
            name="span1",
            attributes={AttributeKey.LangWatchThreadId: "thread-123"},
        )
        span2 = create_mock_span(
            span_id=2,
            name="span2",
            attributes={AttributeKey.LangWatchThreadId: "thread-456"},
        )
        collector.on_end(span1)
        collector.on_end(span2)

        result = collector.get_spans_for_thread("thread-123")

        assert len(result) == 1
        assert result[0].name == "span1"

    def test_returns_empty_list_when_no_matches(self) -> None:
        """Should return empty list when no spans match thread ID."""
        collector = JudgeSpanCollector()
        span = create_mock_span(
            span_id=1,
            name="span1",
            attributes={AttributeKey.LangWatchThreadId: "thread-123"},
        )
        collector.on_end(span)

        result = collector.get_spans_for_thread("thread-999")

        assert len(result) == 0

    def test_returns_child_spans_of_matching_parent(self) -> None:
        """Should return child spans when parent has matching thread ID."""
        collector = JudgeSpanCollector()
        parent = create_mock_span(
            span_id=1,
            name="parent",
            attributes={AttributeKey.LangWatchThreadId: "thread-123"},
        )
        child = create_mock_span(
            span_id=2,
            name="child",
            parent_span_id=1,
            attributes={},
        )
        collector.on_end(parent)
        collector.on_end(child)

        result = collector.get_spans_for_thread("thread-123")

        assert len(result) == 2
        names = [s.name for s in result]
        assert "parent" in names
        assert "child" in names

    def test_returns_deeply_nested_child_spans(self) -> None:
        """Should return deeply nested spans when ancestor has matching thread ID."""
        collector = JudgeSpanCollector()
        grandparent = create_mock_span(
            span_id=1,
            name="grandparent",
            attributes={AttributeKey.LangWatchThreadId: "thread-123"},
        )
        parent = create_mock_span(
            span_id=2,
            name="parent",
            parent_span_id=1,
            attributes={},
        )
        child = create_mock_span(
            span_id=3,
            name="child",
            parent_span_id=2,
            attributes={},
        )
        collector.on_end(grandparent)
        collector.on_end(parent)
        collector.on_end(child)

        result = collector.get_spans_for_thread("thread-123")

        assert len(result) == 3

    def test_excludes_unrelated_spans(self) -> None:
        """Should not return spans from different thread hierarchies."""
        collector = JudgeSpanCollector()
        span_a = create_mock_span(
            span_id=1,
            name="span_a",
            attributes={AttributeKey.LangWatchThreadId: "thread-A"},
        )
        span_b = create_mock_span(
            span_id=2,
            name="span_b",
            attributes={AttributeKey.LangWatchThreadId: "thread-B"},
        )
        collector.on_end(span_a)
        collector.on_end(span_b)

        result = collector.get_spans_for_thread("thread-A")

        assert len(result) == 1
        assert result[0].name == "span_a"
