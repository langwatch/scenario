"""
Shared span utility functions for OpenTelemetry span processing.

Standalone public functions for calculating durations, formatting timestamps,
extracting status indicators, token usage, and cleaning attributes.
Used by both the digest formatter and trace discovery tools.
"""

from datetime import datetime, timezone
from typing import Any, Dict

from langwatch.attributes import AttributeKey
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import StatusCode


def hr_time_to_ms(hr_time: int) -> float:
    """
    Converts OpenTelemetry nanosecond timestamp to milliseconds.

    Args:
        hr_time: Time in nanoseconds.

    Returns:
        Time in milliseconds.
    """
    return hr_time / 1_000_000


def calculate_span_duration(span: ReadableSpan) -> float:
    """
    Calculates span duration in milliseconds.

    Args:
        span: The OpenTelemetry span.

    Returns:
        Duration in milliseconds.
    """
    start = span.start_time or 0
    end = span.end_time or 0
    return hr_time_to_ms(end) - hr_time_to_ms(start)


def format_duration(ms: float) -> str:
    """
    Formats a duration in milliseconds to a human-readable string.

    Uses milliseconds for durations under 1 second, seconds with
    2 decimal places otherwise.

    Args:
        ms: Duration in milliseconds.

    Returns:
        Formatted duration string (e.g. "150ms" or "2.50s").
    """
    if ms < 1000:
        return f"{round(ms)}ms"
    return f"{ms / 1000:.2f}s"


def format_timestamp(start_time_ns: int) -> str:
    """
    Formats a nanosecond timestamp as an ISO 8601 string.

    Args:
        start_time_ns: Timestamp in nanoseconds.

    Returns:
        ISO 8601 formatted timestamp string with Z suffix.
    """
    ms = hr_time_to_ms(start_time_ns)
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def get_status_indicator(span: ReadableSpan) -> str:
    """
    Returns an error status indicator string for a span.

    Args:
        span: The OpenTelemetry span.

    Returns:
        Error indicator string, or empty string for non-error spans.
    """
    if span.status.status_code == StatusCode.ERROR:
        message = span.status.description or "unknown"
        return f" ⚠️ ERROR: {message}"
    return ""


def get_token_usage(span: ReadableSpan) -> str:
    """
    Returns a token usage string for LLM spans using GenAI OTel semantic
    convention attributes (gen_ai.usage.input_tokens + gen_ai.usage.output_tokens).

    Args:
        span: The OpenTelemetry span.

    Returns:
        Token usage string (e.g. ", 1500 tokens"), or empty string if
        no usage attributes are present.
    """
    attrs = dict(span.attributes) if span.attributes else {}
    input_tokens = attrs.get("gen_ai.usage.input_tokens")
    output_tokens = attrs.get("gen_ai.usage.output_tokens")
    if input_tokens is None and output_tokens is None:
        return ""
    total = (int(str(input_tokens)) if input_tokens is not None else 0) + (
        int(str(output_tokens)) if output_tokens is not None else 0
    )
    return f", {total} tokens"


def clean_attributes(attrs: Dict[str, Any]) -> Dict[str, Any]:
    """
    Removes internal/infrastructure attributes from a span's attribute map.

    Strips the ``langwatch.`` prefix from remaining keys and deduplicates.

    Args:
        attrs: Raw attribute dictionary.

    Returns:
        Cleaned attribute dictionary.
    """
    cleaned: Dict[str, Any] = {}
    seen: set = set()

    excluded_keys = [
        AttributeKey.LangWatchThreadId,
        "langwatch.scenario.id",
        "langwatch.scenario.name",
    ]

    for key, value in attrs.items():
        if key in excluded_keys:
            continue
        clean_key = (
            key.replace("langwatch.", "", 1)
            if key.startswith("langwatch.")
            else key
        )
        if clean_key not in seen:
            seen.add(clean_key)
            cleaned[clean_key] = value

    return cleaned


def get_parent_span_id(span: ReadableSpan) -> int | None:
    """
    Extracts the parent span ID from a ReadableSpan.

    Args:
        span: The OpenTelemetry span.

    Returns:
        Parent span ID, or None if the span has no parent.
    """
    if span.parent is not None:
        return span.parent.span_id  # type: ignore[union-attr]
    return None
