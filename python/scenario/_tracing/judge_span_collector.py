"""
Collects OpenTelemetry spans for judge evaluation.

Implements SpanProcessor to intercept spans as they complete,
storing them for later retrieval by thread ID.
"""

from typing import Iterable, List, Dict, Optional, Set
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
        # Every span id this process ever STARTED, keyed by trace id. The
        # remote trace fetcher uses it to recognize the scenario process's
        # own spans when the platform echoes them back. The per-thread view
        # below cannot serve that: it walks ancestor attributes, and the walk
        # breaks on spans whose ancestor chain crosses a still-open span (the
        # current turn's spans) or whose instrumentation never tags the
        # thread id (the judge's own model calls via instrumented SDKs).
        self._process_span_ids: Dict[int, Set[int]] = {}
        # Trace ids the remote trace fetcher settled, per thread. Clearing a
        # thread by ended-span discovery cannot reach every registry entry:
        # a fetched trace's local echoes may never end, or never associate
        # with the thread (an instrumented SDK's model call carries no
        # thread id). The fetcher claims the trace ids it touches, and
        # clear_spans_for_thread releases the claims with the thread.
        self._thread_trace_ids: Dict[str, Set[int]] = {}

    def on_start(
        self,
        span: ReadableSpan,
        parent_context: Optional[Context] = None,
    ) -> None:
        """Called when a span starts. Registers it as a process span."""
        span_ctx = span.get_span_context()
        if span_ctx:
            self._process_span_ids.setdefault(span_ctx.trace_id, set()).add(
                span_ctx.span_id
            )

    def on_end(self, span: ReadableSpan) -> None:
        """Called when a span ends. Stores the span for later retrieval."""
        self._spans.append(span)

    def shutdown(self) -> None:
        """Shuts down the processor, clearing all stored spans."""
        self._spans = []
        self._process_span_ids = {}
        self._thread_trace_ids = {}

    def claim_traces(self, thread_id: str, trace_ids: Iterable[int]) -> None:
        """Marks the given trace ids as owned by a thread.

        Lets ``clear_spans_for_thread`` release their process-span registry
        entries even when no ended span ties the trace to the thread.
        """
        self._thread_trace_ids.setdefault(thread_id, set()).update(trace_ids)

    def force_flush(self, timeout_millis: Optional[int] = None) -> bool:
        """Force flush is a no-op for this collector."""
        return True

    def is_process_span(self, trace_id: int, span_id: int) -> bool:
        """True when this process started the given span itself.

        A fetched span with this id is a platform echo of a local span,
        never remote evidence.
        """
        return span_id in self._process_span_ids.get(trace_id, set())

    def remove_span_by_id(self, span_id: int) -> None:
        """Removes one span by id.

        Used by the remote trace fetcher to retract a synthetic error span
        when the judge waits once more and the trace settles after all.
        """
        self._spans = [
            s
            for s in self._spans
            if (ctx.span_id if (ctx := s.get_span_context()) else 0) != span_id
        ]

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

        return [
            s
            for s in self._spans
            if self._belongs_to_thread(s, thread_id, span_map, set())
        ]

    def _belongs_to_thread(
        self,
        span: ReadableSpan,
        thread_id: str,
        span_map: Dict[int, ReadableSpan],
        visited: set,
    ) -> bool:
        """Check if span or any ancestor belongs to thread.

        Uses a visited set to protect against cycles in parent chains.
        """
        span_ctx = span.get_span_context()
        span_id = span_ctx.span_id if span_ctx else 0
        if span_id in visited:
            return False
        visited.add(span_id)

        attrs = span.attributes or {}
        if attrs.get(AttributeKey.LangWatchThreadId) == thread_id:
            return True

        parent_ctx = span.parent
        if parent_ctx is not None:
            parent_id = parent_ctx.span_id
            if parent_id in span_map:
                return self._belongs_to_thread(
                    span_map[parent_id], thread_id, span_map, visited
                )

        return False

    def clear_spans_for_thread(self, thread_id: str) -> None:
        """Remove all spans associated with a specific thread.

        Called after a scenario run completes to prevent memory buildup
        in long-lived processes.
        """
        span_map: Dict[int, ReadableSpan] = {}
        for span in self._spans:
            span_ctx = span.get_span_context()
            span_id = span_ctx.span_id if span_ctx else 0
            span_map[span_id] = span

        thread_span_ids = set()
        for span in self._spans:
            if self._belongs_to_thread(span, thread_id, span_map, set()):
                span_ctx = span.get_span_context()
                if span_ctx:
                    thread_span_ids.add(span_ctx.span_id)
                    self._process_span_ids.pop(span_ctx.trace_id, None)

        for trace_id in self._thread_trace_ids.pop(thread_id, set()):
            self._process_span_ids.pop(trace_id, None)

        self._spans = [
            s
            for s in self._spans
            if (ctx.span_id if (ctx := s.get_span_context()) else 0)
            not in thread_span_ids
        ]


# Singleton instance
judge_span_collector = JudgeSpanCollector()
