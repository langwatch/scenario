"""Shared test helper for creating mock OpenTelemetry spans."""

from unittest.mock import MagicMock

from opentelemetry.trace import StatusCode


def create_mock_span(
    *,
    span_id: int,
    name: str,
    start_time: int = 0,
    end_time: int = 0,
    parent_span_id: int | None = None,
    attributes: dict | None = None,
    events: list | None = None,
    status_code: StatusCode = StatusCode.OK,
    status_description: str | None = None,
) -> MagicMock:
    """
    Creates a mock ReadableSpan for testing.

    Args:
        span_id: Unique span identifier.
        name: Span name (e.g. "llm.call").
        start_time: Start time in nanoseconds.
        end_time: End time in nanoseconds.
        parent_span_id: Parent span ID for hierarchy (None for root spans).
        attributes: Span attributes dict.
        events: List of span events (mock objects with name/attributes).
        status_code: OTel StatusCode (OK, ERROR, UNSET).
        status_description: Error message when status_code is ERROR.

    Returns:
        MagicMock configured to behave like a ReadableSpan.
    """
    span = MagicMock()
    span.name = name
    span.start_time = start_time
    span.end_time = end_time
    span.get_span_context.return_value.span_id = span_id
    span.attributes = attributes or {}
    span.events = events or []
    span.status.status_code = status_code
    span.status.description = status_description

    if parent_span_id is not None:
        span.parent = MagicMock()
        span.parent.span_id = parent_span_id
    else:
        span.parent = None

    return span
