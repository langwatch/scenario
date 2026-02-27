"""
Tools for progressive trace discovery: expand_trace and grep_trace.

These standalone functions allow drilling into large OpenTelemetry traces
on demand, either by expanding specific spans or searching across all span
content. They are used by the judge agent's multi-step tool loop and are
also available as standalone utilities.
"""

import json
import re
from dataclasses import dataclass
from typing import List, NamedTuple, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan

from .span_utils import (
    calculate_span_duration,
    clean_attributes,
    format_duration,
    format_timestamp,
    get_status_indicator,
)

# Budget constants
TOOL_RESULT_TOKEN_BUDGET = 4096
"""Maximum estimated tokens for a single tool result."""

TOOL_RESULT_CHAR_BUDGET = TOOL_RESULT_TOKEN_BUDGET * 4
"""Maximum characters for a single tool result (~4000 tokens * 4 chars)."""

MAX_GREP_MATCHES = 20
"""Maximum number of grep matches returned."""


@dataclass
class _IndexedSpan:
    """A span with a 1-based sequence index assigned after sorting."""

    span: ReadableSpan
    index: int


class _GrepMatch(NamedTuple):
    """A grep match: the indexed span and the lines that matched."""

    span: _IndexedSpan
    matching_lines: list[str]


def _index_spans(spans: Sequence[ReadableSpan]) -> List[_IndexedSpan]:
    """Sorts spans by start time and assigns 1-based sequence indices."""
    sorted_spans = sorted(spans, key=lambda s: s.start_time or 0)
    return [_IndexedSpan(span=span, index=i + 1) for i, span in enumerate(sorted_spans)]


def _truncate_to_char_budget(text: str) -> str:
    """Truncates text to fit within the tool result character budget."""
    if len(text) <= TOOL_RESULT_CHAR_BUDGET:
        return text
    truncated = text[:TOOL_RESULT_CHAR_BUDGET]
    return (
        truncated
        + "\n\n[TRUNCATED] Output exceeded ~4000 token budget. "
        "Use grep_trace(pattern) to search for specific content, "
        "or expand_trace with a narrower range."
    )


def _render_full_span(indexed: _IndexedSpan) -> List[str]:
    """Renders full details for a single indexed span (attributes, events, status)."""
    span = indexed.span
    duration = calculate_span_duration(span)
    timestamp = format_timestamp(span.start_time or 0)
    status = get_status_indicator(span)

    lines: List[str] = []
    lines.append(
        f"[{indexed.index}] {timestamp} {span.name} ({format_duration(duration)}){status}"
    )

    attrs = clean_attributes(dict(span.attributes) if span.attributes else {})
    for key, value in attrs.items():
        lines.append(f"    {key}: {_format_plain_value(value)}")

    if span.events:
        for event in span.events:
            lines.append(f"    [event] {event.name}")
            if event.attributes:
                event_attrs = clean_attributes(dict(event.attributes))
                for key, value in event_attrs.items():
                    lines.append(f"      {key}: {_format_plain_value(value)}")

    return lines


def _format_plain_value(value: object) -> str:
    """Formats a value for display without deduplication."""
    if isinstance(value, str):
        return value
    return json.dumps(value)


def _span_to_searchable_text(span: ReadableSpan) -> str:
    """Serializes a span to a single searchable string for grep matching."""
    parts: List[str] = [span.name]

    attrs = clean_attributes(dict(span.attributes) if span.attributes else {})
    for key, value in attrs.items():
        parts.append(f"{key}: {_format_plain_value(value)}")

    if span.events:
        for event in span.events:
            parts.append(event.name)
            if event.attributes:
                event_attrs = clean_attributes(dict(event.attributes))
                for key, value in event_attrs.items():
                    parts.append(f"{key}: {_format_plain_value(value)}")

    return "\n".join(parts)


def expand_trace(
    spans: Sequence[ReadableSpan],
    *,
    index: Optional[int] = None,
    range_str: Optional[str] = None,
) -> str:
    """
    Expands one or more spans from a trace, returning their full details
    (attributes, events, status) with tree position context.

    Args:
        spans: The full array of ReadableSpan objects for the trace.
        index: Single span index to expand (1-based).
        range_str: Range of span indices to expand, e.g. "10-15".

    Returns:
        Formatted string with full span details, truncated to ~4000 tokens.
    """
    nodes = _index_spans(spans)

    if len(nodes) == 0:
        return "No spans recorded."

    # Parse range into start/end indices
    if range_str is not None:
        parts = range_str.split("-")
        start_idx = int(parts[0])
        end_idx = int(parts[1]) if len(parts) > 1 else start_idx
    elif index is not None:
        start_idx = index
        end_idx = index
    else:
        return "Error: provide either index or range parameter."

    max_index = len(nodes)
    if start_idx < 1 or end_idx > max_index or start_idx > end_idx:
        return f"Error: span index out of range. Valid range is 1-{max_index}."

    # Find requested nodes by index
    selected = [n for n in nodes if start_idx <= n.index <= end_idx]

    lines: List[str] = []
    for node in selected:
        span_lines = _render_full_span(node)
        lines.extend(span_lines)
        lines.append("")

    return _truncate_to_char_budget("\n".join(lines).rstrip())


def grep_trace(spans: Sequence[ReadableSpan], pattern: str) -> str:
    """
    Searches across all span attributes, events, and content for a pattern.
    Returns matching spans with their tree position and matching content.

    Args:
        spans: The full array of ReadableSpan objects for the trace.
        pattern: Case-insensitive search pattern.

    Returns:
        Formatted string with matches, limited to 20 results and ~4000 tokens.
    """
    nodes = _index_spans(spans)

    if len(nodes) == 0:
        return "No spans recorded."

    escaped_pattern = re.escape(pattern)
    regex = re.compile(escaped_pattern, re.IGNORECASE)

    matches: List[_GrepMatch] = []

    for node in nodes:
        search_text = _span_to_searchable_text(node.span)
        text_lines = search_text.split("\n")
        matching_lines = [line for line in text_lines if regex.search(line)]

        if matching_lines:
            matches.append(_GrepMatch(span=node, matching_lines=matching_lines))

    if not matches:
        span_names = list(dict.fromkeys(n.span.name for n in nodes))
        return f'No matches found for "{pattern}". Available span names: {", ".join(span_names)}'

    total_matches = len(matches)
    limited = matches[:MAX_GREP_MATCHES]

    lines: List[str] = []
    for match in limited:
        duration = calculate_span_duration(match.span.span)
        lines.append(
            f"--- [{match.span.index}] {match.span.span.name} ({format_duration(duration)}) ---"
        )
        for line in match.matching_lines:
            lines.append(f"  {line}")
        lines.append("")

    if total_matches > MAX_GREP_MATCHES:
        lines.append(
            f"[{total_matches - MAX_GREP_MATCHES} more matches omitted. "
            "Refine your search pattern for more specific results.]"
        )

    return _truncate_to_char_budget("\n".join(lines).rstrip())
