"""
Collects OpenTelemetry spans for judge evaluation.

Implements SpanProcessor to intercept spans as they complete,
storing them for later retrieval by thread ID.
"""

from typing import List, Dict, Optional
from opentelemetry.context import Context
from opentelemetry.sdk.trace import SpanProcessor, ReadableSpan
from langwatch.attributes import AttributeKey


class JudgeSpanCollector(SpanProcessor):
    """
    Collects OpenTelemetry spans for judge evaluation.

    Implements SpanProcessor to intercept spans as they complete.
    Spans can be retrieved by thread ID for inclusion in judge prompts.
    """

    def __init__(self) -> None:
        self._spans: List[ReadableSpan] = []

    def on_start(
        self,
        span: ReadableSpan,
        parent_context: Optional[Context] = None,
    ) -> None:
        """Called when a span starts. No-op for collection purposes."""
        pass

    def on_end(self, span: ReadableSpan) -> None:
        """Called when a span ends. Stores the span for later retrieval."""
        self._spans.append(span)

    def shutdown(self) -> None:
        """Shuts down the processor, clearing all stored spans."""
        self._spans = []

    def force_flush(self, timeout_millis: Optional[int] = None) -> bool:
        """Force flush is a no-op for this collector."""
        return True

    def get_spans_for_thread(self, thread_id: str) -> List[ReadableSpan]:
        """
        Retrieves all spans associated with a specific thread.

        Traverses parent relationships to find spans belonging to a thread,
        even if the thread ID is only set on an ancestor span.

        Args:
            thread_id: The thread identifier to filter spans by

        Returns:
            List of spans for the given thread
        """
        span_map: Dict[int, ReadableSpan] = {}

        # Index all spans by ID
        for span in self._spans:
            span_ctx = span.get_span_context()
            span_id = span_ctx.span_id if span_ctx else 0
            span_map[span_id] = span

        def belongs_to_thread(span: ReadableSpan) -> bool:
            """Check if span or any ancestor belongs to thread."""
            attrs = span.attributes or {}
            if attrs.get(AttributeKey.LangWatchThreadId) == thread_id:
                return True

            parent_ctx = span.parent
            if parent_ctx is not None:
                parent_id = parent_ctx.span_id
                if parent_id in span_map:
                    return belongs_to_thread(span_map[parent_id])

            return False

        return [s for s in self._spans if belongs_to_thread(s)]


# Singleton instance
judge_span_collector = JudgeSpanCollector()
