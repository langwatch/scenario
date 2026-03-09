"""Tests for FilteringSpanExporter."""

import pytest
from unittest.mock import MagicMock
from opentelemetry.sdk.trace.export import SpanExportResult
from scenario._tracing.filtering_exporter import FilteringSpanExporter


def _make_span(name: str) -> MagicMock:
    """Create a mock ReadableSpan."""
    span = MagicMock()
    span.name = name
    return span


class TestFilteringSpanExporter:
    """Tests for FilteringSpanExporter."""

    def test_forwards_matching_spans(self) -> None:
        inner = MagicMock()
        inner.export.return_value = SpanExportResult.SUCCESS

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: s.name == "keep",
        )

        span_keep = _make_span("keep")
        span_drop = _make_span("drop")

        result = exporter.export([span_keep, span_drop])

        assert result == SpanExportResult.SUCCESS
        inner.export.assert_called_once_with([span_keep])

    def test_drops_non_matching_spans(self) -> None:
        inner = MagicMock()

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: s.name == "keep",
        )

        span_drop = _make_span("drop")

        result = exporter.export([span_drop])

        assert result == SpanExportResult.SUCCESS
        inner.export.assert_not_called()

    def test_returns_success_for_empty_batch(self) -> None:
        inner = MagicMock()

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: True,
        )

        result = exporter.export([])

        assert result == SpanExportResult.SUCCESS
        inner.export.assert_not_called()

    def test_delegates_shutdown(self) -> None:
        inner = MagicMock()

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: True,
        )

        exporter.shutdown()

        inner.shutdown.assert_called_once()

    def test_delegates_force_flush(self) -> None:
        inner = MagicMock()
        inner.force_flush.return_value = True

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: True,
        )

        result = exporter.force_flush(timeout_millis=5000)

        assert result is True
        inner.force_flush.assert_called_once_with(5000)

    def test_propagates_inner_export_failure(self) -> None:
        inner = MagicMock()
        inner.export.return_value = SpanExportResult.FAILURE

        exporter = FilteringSpanExporter(
            exporter=inner,
            span_filter=lambda s: True,
        )

        span = _make_span("test")
        result = exporter.export([span])

        assert result == SpanExportResult.FAILURE
