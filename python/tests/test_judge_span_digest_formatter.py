"""Tests for JudgeSpanDigestFormatter."""

from typing import Any, cast
from unittest.mock import MagicMock

import pytest
from langwatch.attributes import AttributeKey
from opentelemetry.trace import StatusCode

from scenario._judge.judge_span_digest_formatter import JudgeSpanDigestFormatter

from tests.helpers.create_span import create_mock_span


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
            span_id=0xA1B2C3D400000000,
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
            span_id=0xA1B2C3D400000000,
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
                span_id=0xBBBB000000000000,
                name="second",
                start_time=1700000001_000_000_000,
                end_time=1700000001_100_000_000,
            ),
            create_mock_span(
                span_id=0xAAAA000000000000,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
        ]

        result = formatter.format(spans)

        first_idx = result.index("first")
        second_idx = result.index("second")
        assert first_idx < second_idx

    def test_shows_span_ids(self) -> None:
        """Should show truncated span IDs."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0xAAAA000000000000,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
                name="second",
                start_time=1700000001_000_000_000,
                end_time=1700000001_100_000_000,
            ),
        ]

        result = formatter.format(spans)

        assert "[aaaa0000]" in result
        assert "[bbbb0000]" in result


class TestJudgeSpanDigestFormatterHierarchy:
    """Tests for parent-child span hierarchy."""

    def test_nests_children_under_parent(self) -> None:
        """Should nest child spans under parent."""
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0x1111000000000000,
                name="parent",
                start_time=1700000000_000_000_000,
                end_time=1700000001_000_000_000,
            ),
            create_mock_span(
                span_id=0x2222000000000000,
                name="child",
                parent_span_id=0x1111000000000000,
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
            span_id=0xAAAA000000000000,
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
                span_id=0xAAAA000000000000,
                name="successful",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
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
            span_id=0xAAAA000000000000,
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
            span_id=0xAAAA000000000000,
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
                span_id=0xAAAA000000000000,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
                attributes={"content": long_content},
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
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
                span_id=0xAAAA000000000000,
                name="first",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
                attributes={"content": short_content},
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
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
            span_id=0xAAAA000000000000,
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


class TestFormatStructureOnlyEmpty:
    """Tests for format_structure_only with empty spans."""

    def test_returns_empty_marker_when_no_spans(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        result = formatter.format_structure_only([])
        assert result == "No spans recorded."


class TestFormatStructureOnlyOmitsDetails:
    """Tests for format_structure_only omitting attributes and events."""

    def test_shows_span_id_timestamp_name_duration_omits_attributes_and_events(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        event = MagicMock()
        event.name = "token.generated"
        event.attributes = {"token": "Hi"}

        span = create_mock_span(
            span_id=0xA1B2C3D400000000,
            name="llm.chat",
            start_time=1700000000_000_000_000,
            end_time=1700000000_500_000_000,
            attributes={
                "gen_ai.prompt": "Hello",
                "gen_ai.completion": "Hi there!",
                "model": "gpt-4",
            },
            events=[event],
        )

        result = formatter.format_structure_only([span])

        assert "[a1b2c3d4]" in result
        assert "llm.chat" in result
        assert "500ms" in result
        # Should NOT contain attributes or events
        assert "gen_ai.prompt" not in result
        assert "Hello" not in result
        assert "Hi there!" not in result
        assert "gpt-4" not in result
        assert "token.generated" not in result


class TestFormatStructureOnlyHierarchy:
    """Tests for format_structure_only preserving span tree hierarchy."""

    def test_preserves_tree_structure_with_indentation(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0x1111000000000000,
                name="agent.run",
                start_time=1700000000_000_000_000,
                end_time=1700000001_000_000_000,
            ),
            create_mock_span(
                span_id=0x2222000000000000,
                name="llm.call",
                parent_span_id=0x1111000000000000,
                start_time=1700000000_100_000_000,
                end_time=1700000000_500_000_000,
            ),
            create_mock_span(
                span_id=0x3333000000000000,
                name="tool.execute",
                parent_span_id=0x1111000000000000,
                start_time=1700000000_600_000_000,
                end_time=1700000000_900_000_000,
            ),
        ]

        result = formatter.format_structure_only(spans)

        assert "[11110000]" in result
        assert "agent.run" in result
        assert "[22220000]" in result
        assert "llm.call" in result
        assert "[33330000]" in result
        assert "tool.execute" in result


class TestFormatStructureOnlyErrors:
    """Tests for format_structure_only error handling."""

    def test_includes_error_indicator_and_error_summary(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0xAAAA000000000000,
                name="successful.operation",
                start_time=1700000000_000_000_000,
                end_time=1700000000_100_000_000,
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
                name="failed.operation",
                start_time=1700000000_200_000_000,
                end_time=1700000000_300_000_000,
                status_code=StatusCode.ERROR,
                status_description="Connection refused",
            ),
        ]

        result = formatter.format_structure_only(spans)

        assert "ERROR" in result
        assert "Connection refused" in result
        assert "=== ERRORS ===" in result


class TestFormatStructureOnlyHeader:
    """Tests for format_structure_only header with span count and duration."""

    def test_includes_header_with_span_count_and_total_duration(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0xAAAA000000000000,
                name="op1",
                start_time=1700000000_000_000_000,
                end_time=1700000001_000_000_000,
            ),
            create_mock_span(
                span_id=0xBBBB000000000000,
                name="op2",
                start_time=1700000001_000_000_000,
                end_time=1700000002_000_000_000,
            ),
        ]

        result = formatter.format_structure_only(spans)

        assert "Spans: 2" in result
        assert "Total Duration:" in result


class TestFormatStructureOnlyTokenUsage:
    """Tests for token usage display in structure-only mode."""

    def test_shows_total_token_count_for_llm_spans(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        spans = [
            create_mock_span(
                span_id=0x1111000000000000,
                name="agent.run",
                start_time=1700000000_000_000_000,
                end_time=1700000010_000_000_000,
            ),
            create_mock_span(
                span_id=0x2222000000000000,
                name="chat claude-opus-4-6",
                parent_span_id=0x1111000000000000,
                start_time=1700000001_000_000_000,
                end_time=1700000006_000_000_000,
                attributes={
                    "gen_ai.usage.input_tokens": 18000,
                    "gen_ai.usage.output_tokens": 3693,
                },
            ),
            create_mock_span(
                span_id=0x3333000000000000,
                name="execute_tool exec",
                parent_span_id=0x1111000000000000,
                start_time=1700000006_000_000_000,
                end_time=1700000007_500_000_000,
            ),
        ]

        result = formatter.format_structure_only(spans)

        assert "chat claude-opus-4-6 (5.00s, 21693 tokens)" in result
        # Non-LLM spans should NOT show token info
        assert "execute_tool exec (1.50s)" in result
        assert "execute_tool exec (1.50s," not in result

    def test_shows_tokens_when_only_input_tokens_present(self) -> None:
        formatter = JudgeSpanDigestFormatter()
        span = create_mock_span(
            span_id=0xAAAA000000000000,
            name="llm.call",
            start_time=1700000000_000_000_000,
            end_time=1700000001_000_000_000,
            attributes={
                "gen_ai.usage.input_tokens": 500,
            },
        )

        result = formatter.format_structure_only([span])

        assert "llm.call (1.00s, 500 tokens)" in result

    def test_does_not_include_usage_hint(self) -> None:
        """Caller is responsible for appending usage hint, not the formatter."""
        formatter = JudgeSpanDigestFormatter()
        span = create_mock_span(
            span_id=0xAAAA000000000000,
            name="test",
            start_time=1700000000_000_000_000,
            end_time=1700000000_100_000_000,
        )

        result = formatter.format_structure_only([span])

        assert "expand_trace" not in result
        assert "grep_trace" not in result
