"""A span exporter wrapper that filters spans before export."""

from typing import Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from .filters import SpanFilter


class FilteringSpanExporter(SpanExporter):
    """Wraps another SpanExporter and filters spans before exporting."""

    def __init__(self, exporter: SpanExporter, span_filter: SpanFilter):
        self._exporter = exporter
        self._span_filter = span_filter

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        filtered = [s for s in spans if self._span_filter(s)]
        if not filtered:
            return SpanExportResult.SUCCESS
        return self._exporter.export(filtered)

    def shutdown(self) -> None:
        self._exporter.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._exporter.force_flush(timeout_millis)
