"""
Formats OpenTelemetry spans into a plain-text digest for judge evaluation.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import StatusCode

from .deep_transform import deep_transform
from .span_utils import (
    calculate_span_duration,
    clean_attributes,
    format_duration,
    format_timestamp,
    get_status_indicator,
    get_token_usage,
    hr_time_to_ms,
)
from .string_deduplicator import StringDeduplicator
from .truncate_media import truncate_media_url, truncate_media_part


logger = logging.getLogger("scenario.judge")


@dataclass
class SpanNode:
    """Represents a span node in the hierarchy tree."""

    span: ReadableSpan
    children: List["SpanNode"]


class JudgeSpanDigestFormatter:
    """
    Transforms OpenTelemetry spans into a complete plain-text digest for judge evaluation.

    Deduplicates repeated string content to reduce token usage.
    """

    def __init__(self) -> None:
        self._deduplicator = StringDeduplicator(threshold=50)

    def format_structure_only(self, spans: Sequence[ReadableSpan]) -> str:
        """
        Formats spans into a structure-only digest showing span tree hierarchy
        without attributes, events, or content. Used for large traces that
        exceed the token threshold, paired with expand_trace/grep_trace tools.

        Args:
            spans: All spans for a thread.

        Returns:
            Plain text digest with only structural information.
        """
        logger.debug(
            "format_structure_only() called",
            extra={"span_count": len(spans)},
        )

        if not spans:
            return "No spans recorded."

        sorted_spans = self._sort_by_start_time(spans)
        tree = self._build_hierarchy(sorted_spans)
        total_duration = self._calculate_total_duration(sorted_spans)

        lines: List[str] = [
            f"Spans: {len(spans)} | Total Duration: {format_duration(total_duration)}",
            "",
        ]

        root_count = len(tree)
        for idx, node in enumerate(tree):
            self._render_structure_node(
                node, lines, depth=0, is_last=(idx == root_count - 1)
            )

        errors = self._collect_errors(spans)
        if errors:
            lines.append("")
            lines.append("=== ERRORS ===")
            lines.extend(errors)

        return "\n".join(lines)

    def format(self, spans: Sequence[ReadableSpan]) -> str:
        """
        Formats spans into a complete digest with full content and nesting.

        Args:
            spans: All spans for a thread

        Returns:
            Plain text digest
        """
        self._deduplicator.reset()

        logger.debug(
            "format() called",
            extra={
                "span_count": len(spans),
                "span_names": [s.name for s in spans],
            },
        )

        if not spans:
            logger.debug("No spans to format")
            return "No spans recorded."

        sorted_spans = self._sort_by_start_time(spans)
        tree = self._build_hierarchy(sorted_spans)
        total_duration = self._calculate_total_duration(sorted_spans)

        logger.debug(
            "Hierarchy built",
            extra={
                "root_count": len(tree),
                "total_duration": total_duration,
            },
        )

        lines: List[str] = [
            f"Spans: {len(spans)} | Total Duration: {format_duration(total_duration)}",
            "",
        ]

        root_count = len(tree)
        for idx, node in enumerate(tree):
            self._render_node(
                node, lines, depth=0, is_last=(idx == root_count - 1)
            )

        errors = self._collect_errors(spans)
        if errors:
            lines.append("")
            lines.append("=== ERRORS ===")
            lines.extend(errors)

        return "\n".join(lines)

    def _sort_by_start_time(self, spans: Sequence[ReadableSpan]) -> List[ReadableSpan]:
        """Sorts spans by start time."""
        return sorted(spans, key=lambda s: hr_time_to_ms(s.start_time or 0))

    def _build_hierarchy(self, spans: List[ReadableSpan]) -> List[SpanNode]:
        """Builds a tree structure from flat span list."""
        span_map: Dict[int, SpanNode] = {}
        roots: List[SpanNode] = []

        for span in spans:
            span_ctx = span.get_span_context()
            span_id = span_ctx.span_id if span_ctx else 0
            span_map[span_id] = SpanNode(span=span, children=[])

        for span in spans:
            span_ctx = span.get_span_context()
            span_id = span_ctx.span_id if span_ctx else 0
            node = span_map[span_id]
            parent_ctx = span.parent

            if parent_ctx is not None:
                parent_id = parent_ctx.span_id
                if parent_id in span_map:
                    span_map[parent_id].children.append(node)
                else:
                    roots.append(node)
            else:
                roots.append(node)

        return roots

    def _render_structure_node(
        self,
        node: SpanNode,
        lines: List[str],
        depth: int,
        is_last: bool = True,
    ) -> None:
        """Renders a span node in structure-only mode (no attributes/events)."""
        span = node.span
        span_ctx = span.get_span_context()
        short_id = format(span_ctx.span_id if span_ctx else 0, "016x")[:8]
        duration = calculate_span_duration(span)
        timestamp = format_timestamp(span.start_time or 0)
        status = get_status_indicator(span)
        tokens = get_token_usage(span)

        prefix = self._get_tree_prefix(depth, is_last)
        lines.append(
            f"{prefix}[{short_id}] {timestamp} {span.name} ({format_duration(duration)}{tokens}){status}"
        )
        lines.append("")

        child_count = len(node.children)
        for idx, child in enumerate(node.children):
            self._render_structure_node(
                child, lines, depth + 1, is_last=(idx == child_count - 1)
            )

    def _render_node(
        self,
        node: SpanNode,
        lines: List[str],
        depth: int,
        is_last: bool = True,
    ) -> None:
        """Renders a span node and its children."""
        span = node.span
        span_ctx = span.get_span_context()
        short_id = format(span_ctx.span_id if span_ctx else 0, "016x")[:8]
        duration = calculate_span_duration(span)
        timestamp = format_timestamp(span.start_time or 0)
        status = get_status_indicator(span)

        prefix = self._get_tree_prefix(depth, is_last)
        lines.append(
            f"{prefix}[{short_id}] {timestamp} {span.name} ({format_duration(duration)}){status}"
        )

        attr_indent = self._get_attr_indent(depth, is_last)
        attrs = clean_attributes(dict(span.attributes) if span.attributes else {})
        for key, value in attrs.items():
            lines.append(f"{attr_indent}{key}: {self._format_value(value)}")

        if span.events:
            for event in span.events:
                lines.append(f"{attr_indent}[event] {event.name}")
                if event.attributes:
                    event_attrs = clean_attributes(dict(event.attributes))
                    for key, value in event_attrs.items():
                        lines.append(
                            f"{attr_indent}  {key}: {self._format_value(value)}"
                        )

        lines.append("")

        child_count = len(node.children)
        for idx, child in enumerate(node.children):
            self._render_node(
                child, lines, depth + 1, is_last=(idx == child_count - 1)
            )

    def _get_tree_prefix(self, depth: int, is_last: bool) -> str:
        """Gets tree drawing prefix for a given depth."""
        if depth == 0:
            return ""
        connector = "└── " if is_last else "├── "
        return "│   " * (depth - 1) + connector

    def _get_attr_indent(self, depth: int, is_last: bool) -> str:
        """Gets attribute indentation for a given depth."""
        if depth == 0:
            return "    "
        continuation = "    " if is_last else "│   "
        return "│   " * (depth - 1) + continuation + "    "

    def _format_value(self, value: Any) -> str:
        """Formats a value for display with deduplication."""
        processed = self._transform_value(value)
        if isinstance(processed, str):
            return processed
        return json.dumps(processed)

    def _transform_value(self, value: Any) -> Any:
        """Transforms a value, handling media and deduplication."""

        def transform_fn(v: Any) -> Any:
            # AI SDK media parts
            media_part = truncate_media_part(v)
            if media_part is not None:
                return media_part

            # Not a string - continue traversal
            if not isinstance(v, str):
                return v

            # String transforms
            return self._transform_string(v)

        return deep_transform(value, transform_fn)

    def _transform_string(self, s: str) -> str:
        """Transforms a string, handling JSON, data URLs, and deduplication."""
        # JSON strings - parse and recurse
        if self._looks_like_json(s):
            try:
                processed = self._transform_value(json.loads(s))
                return json.dumps(processed)
            except json.JSONDecodeError:
                pass

        # Data URLs -> marker
        truncated = truncate_media_url(s)
        if truncated != s:
            return truncated

        # Dedup
        return self._deduplicator.process(s)

    def _looks_like_json(self, s: str) -> bool:
        """Checks if a string looks like JSON."""
        t = s.strip()
        return (t.startswith("{") and t.endswith("}")) or (
            t.startswith("[") and t.endswith("]")
        )

    def _calculate_total_duration(self, spans: List[ReadableSpan]) -> float:
        """Calculates total duration from first start to last end."""
        if not spans:
            return 0
        first = hr_time_to_ms(spans[0].start_time or 0)
        last = max(hr_time_to_ms(s.end_time or 0) for s in spans)
        return last - first

    def _collect_errors(self, spans: Sequence[ReadableSpan]) -> List[str]:
        """Collects error messages from failed spans."""
        errors = []
        for s in spans:
            if s.status.status_code == StatusCode.ERROR:
                message = s.status.description or "unknown error"
                errors.append(f"- {s.name}: {message}")
        return errors


# Singleton instance
judge_span_digest_formatter = JudgeSpanDigestFormatter()
