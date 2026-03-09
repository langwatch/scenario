"""Filter presets for controlling which spans are exported to LangWatch."""

from typing import Callable, List

from opentelemetry.sdk.trace import ReadableSpan

# Type alias
SpanFilter = Callable[[ReadableSpan], bool]


def _get_scope_name(span: ReadableSpan) -> str:
    """Get the instrumentation scope name from a span."""
    scope = getattr(span, "instrumentation_scope", None) or getattr(
        span, "instrumentation_info", None
    )
    if scope:
        return getattr(scope, "name", "unknown")
    return "unknown"


def scenario_only(span: ReadableSpan) -> bool:
    """Only keep spans from the scenario instrumentation scope.

    Use this to prevent unrelated server spans (HTTP, middleware, etc.)
    from being exported.

    Example:
        from scenario import setup_scenario_tracing, scenario_only

        setup_scenario_tracing(
            span_filter=scenario_only,
            instrumentors=[],
        )
    """
    return _get_scope_name(span) == "langwatch"


def with_custom_scopes(*scopes: str) -> SpanFilter:
    """Keep spans from scenario scope plus additional custom scopes.

    Example:
        from scenario import setup_scenario_tracing, with_custom_scopes

        setup_scenario_tracing(
            span_filter=with_custom_scopes("my-app/database", "my-app/agent"),
            instrumentors=[],
        )
    """
    allowed = {"langwatch", *scopes}

    def filter_fn(span: ReadableSpan) -> bool:
        return _get_scope_name(span) in allowed

    return filter_fn
