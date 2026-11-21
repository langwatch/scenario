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
from typing import List, NamedTuple, Sequence

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

GREP_CONTEXT_CHARS = 400
"""Characters of context kept on each side of a grep match."""

MAX_WINDOWS_PER_LINE = 5
"""Maximum windows shown per matching line."""


def _page_to_char_budget(text: str, offset: int) -> str:
    """One page of an expand_trace result, starting at ``offset`` characters.

    The footer names the offset of the next page, so content past the budget
    stays reachable.
    """
    start = max(0, min(int(offset), len(text)))
    if start == 0 and len(text) <= TOOL_RESULT_CHAR_BUDGET:
        return text
    end = min(start + TOOL_RESULT_CHAR_BUDGET, len(text))
    header = f"[Showing characters {start}-{end} of {len(text)}]\n" if start > 0 else ""
    footer = (
        f"\n\n[TRUNCATED] Showing characters {start}-{end} of {len(text)}: "
        f"{len(text) - end} more characters of these spans are not shown, so do "
        "not conclude that something is absent from them. Call expand_trace "
        f"with the same span IDs and offset={end} to read on, or "
        "grep_trace(pattern) to jump to specific content."
        if end < len(text)
        else ""
    )
    return header + text[start:end] + footer


def _match_windows(line: str, regex: "re.Pattern[str]") -> List[str]:
    """The parts of a long line around each match of ``regex``.

    A match deep inside one long attribute (retrieved documents serialized as
    one JSON value) is shown instead of being cut off by the result budget.
    """
    if len(line) <= GREP_CONTEXT_CHARS * 2:
        return [line]
    windows: List[str] = []
    last_end = -1
    for match in regex.finditer(line):
        if len(windows) >= MAX_WINDOWS_PER_LINE:
            break
        at = match.start()
        if at < last_end:
            continue
        start = max(0, at - GREP_CONTEXT_CHARS)
        end = min(len(line), match.end() + GREP_CONTEXT_CHARS)
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(line) else ""
        windows.append(
            f"{prefix}{line[start:end]}{suffix} [match at character {at} of {len(line)}]"
        )
        last_end = end
    return windows


@dataclass
class _IndexedSpan:
    """A span with a truncated span ID (first 8 hex chars) assigned from the span context."""

    span: ReadableSpan
    short_id: str


class _GrepMatch(NamedTuple):
    """A grep match: the indexed span and the lines that matched."""

    span: _IndexedSpan
    matching_lines: list[str]


def _get_span_id_hex(span: ReadableSpan) -> str:
    """Returns the full 16-char hex representation of a span's ID."""
    ctx = span.get_span_context()
    return format(ctx.span_id, "016x") if ctx else "0" * 16


def _index_spans(spans: Sequence[ReadableSpan]) -> List[_IndexedSpan]:
    """Sorts spans by start time and assigns truncated span IDs (first 8 hex chars)."""
    sorted_spans = sorted(spans, key=lambda s: s.start_time or 0)
    return [
        _IndexedSpan(span=span, short_id=_get_span_id_hex(span)[:8])
        for span in sorted_spans
    ]


def _truncate_to_char_budget(text: str) -> str:
    """Truncates text to fit within the tool result character budget."""
    if len(text) <= TOOL_RESULT_CHAR_BUDGET:
        return text
    truncated = text[:TOOL_RESULT_CHAR_BUDGET]
    return (
        truncated
        + "\n\n[TRUNCATED] Output exceeded ~4000 token budget. "
        "Use grep_trace(pattern) to search for specific content, "
        "or expand_trace with fewer span IDs."
    )


def _render_full_span(indexed: _IndexedSpan) -> List[str]:
    """Renders full details for a single indexed span (attributes, events, status)."""
    span = indexed.span
    duration = calculate_span_duration(span)
    timestamp = format_timestamp(span.start_time or 0)
    status = get_status_indicator(span)

    lines: List[str] = []
    lines.append(
        f"[{indexed.short_id}] {timestamp} {span.name} ({format_duration(duration)}){status}"
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
    span_ids: List[str],
    offset: int = 0,
) -> str:
    """
    Expands one or more spans from a trace, returning their full details
    (attributes, events, status) with tree position context.

    Spans are matched by prefix: the caller can pass the truncated 8-char
    span ID shown in the skeleton and it will match any span whose full ID
    starts with that prefix.

    Args:
        spans: The full array of ReadableSpan objects for the trace.
        span_ids: Span IDs (or 8-char prefixes) to expand.
        offset: Character offset of the page to return, for long spans.

    Returns:
        Formatted string with full span details, one ~4096 token page.
    """
    nodes = _index_spans(spans)

    if len(nodes) == 0:
        return "No spans recorded."

    if len(span_ids) == 0:
        return "Error: provide at least one span ID."

    # Match nodes by prefix
    selected = [
        n
        for n in nodes
        if any(
            _get_span_id_hex(n.span).startswith(prefix)
            for prefix in span_ids
        )
    ]

    if not selected:
        available = ", ".join(n.short_id for n in nodes)
        return f"Error: no spans matched the given ID(s). Available span IDs: {available}"

    lines: List[str] = []
    for node in selected:
        span_lines = _render_full_span(node)
        lines.extend(span_lines)
        lines.append("")

    return _page_to_char_budget("\n".join(lines).rstrip(), offset)


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
            f"--- [{match.span.short_id}] {match.span.span.name} ({format_duration(duration)}) ---"
        )
        for line in match.matching_lines:
            for window in _match_windows(line, regex):
                lines.append(f"  {window}")
        lines.append("")

    if total_matches > MAX_GREP_MATCHES:
        lines.append(
            f"[{total_matches - MAX_GREP_MATCHES} more matches omitted. "
            "Refine your search pattern for more specific results.]"
        )

    return _truncate_to_char_budget("\n".join(lines).rstrip())
