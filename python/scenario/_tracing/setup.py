"""Configurable tracing setup for scenario testing.

Supports:
- Lazy initialization (deferred to first run() call)
- Explicit initialization via setup_scenario_tracing()
- Span filtering via scenario_only / with_custom_scopes presets
- Detection of pre-existing OTel providers
- Custom span processors and exporters
"""

import logging
import os
from typing import List, Optional, Sequence

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider, SpanProcessor
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter

from .judge_span_collector import judge_span_collector
from .filters import SpanFilter
from .filtering_exporter import FilteringSpanExporter

logger = logging.getLogger("scenario.tracing")

_initialized = False


def setup_scenario_tracing(
    *,
    span_filter: Optional[SpanFilter] = None,
    span_processors: Optional[List[SpanProcessor]] = None,
    trace_exporter: Optional[SpanExporter] = None,
    instrumentors: Optional[Sequence] = None,
) -> None:
    """Explicitly set up tracing for scenario.

    Call this before any run() invocations when you want full control
    over the observability configuration. If called, run() will skip
    its own lazy initialization.

    The judge_span_collector is always added as a span processor regardless
    of user-provided options.

    Args:
        span_filter: Filter function to control which spans are exported.
            Use scenario_only or with_custom_scopes() presets.
        span_processors: Additional span processors to register.
        trace_exporter: Custom span exporter. If span_filter is also provided,
            this exporter will be wrapped with the filter.
        instrumentors: OpenTelemetry instrumentors to register. Pass [] to
            disable auto-instrumentation.
    """
    global _initialized
    if _initialized:
        return

    _do_setup(
        span_filter=span_filter,
        span_processors=span_processors,
        trace_exporter=trace_exporter,
        instrumentors=instrumentors,
    )
    _initialized = True


def ensure_tracing_initialized(observability: Optional[dict] = None) -> None:
    """Ensures tracing is initialized before a scenario run.

    Called internally by run(). If setup_scenario_tracing() was already
    called, this is a no-op.

    Args:
        observability: Optional dict from ScenarioConfig.observability with keys:
            span_filter, span_processors, trace_exporter, instrumentors.
    """
    global _initialized
    if _initialized:
        return
    if observability:
        _do_setup(
            span_filter=observability.get("span_filter"),
            span_processors=observability.get("span_processors"),
            trace_exporter=observability.get("trace_exporter"),
            instrumentors=observability.get("instrumentors"),
        )
    else:
        _do_setup()
    _initialized = True


def _get_concrete_provider(provider) -> Optional[TracerProvider]:
    """Returns the concrete TracerProvider if one exists.

    Checks the provider itself and one level of delegation
    (for ProxyTracerProvider pattern).
    """
    if isinstance(provider, TracerProvider):
        return provider

    # Check delegation pattern
    delegate = None
    if hasattr(provider, "get_delegate"):
        delegate = provider.get_delegate()
    elif hasattr(provider, "_delegate"):
        delegate = provider._delegate

    if isinstance(delegate, TracerProvider):
        return delegate

    return None


def _do_setup(
    *,
    span_filter: Optional[SpanFilter] = None,
    span_processors: Optional[List[SpanProcessor]] = None,
    trace_exporter: Optional[SpanExporter] = None,
    instrumentors: Optional[Sequence] = None,
) -> None:
    """Internal setup logic."""
    existing_provider = trace.get_tracer_provider()
    concrete = _get_concrete_provider(existing_provider)

    if concrete is not None:
        _attach_to_existing(concrete, span_filter, span_processors, trace_exporter)
    else:
        _full_setup(span_filter, span_processors, trace_exporter, instrumentors)


def _attach_to_existing(
    provider: TracerProvider,
    span_filter: Optional[SpanFilter],
    span_processors: Optional[List[SpanProcessor]],
    trace_exporter: Optional[SpanExporter],
) -> None:
    """Attach processors to an existing TracerProvider."""
    provider.add_span_processor(judge_span_collector)
    logger.debug("Added judge span collector to existing TracerProvider")

    if span_processors:
        for processor in span_processors:
            provider.add_span_processor(processor)

    if trace_exporter:
        exporter = trace_exporter
        if span_filter:
            exporter = FilteringSpanExporter(exporter, span_filter)
        provider.add_span_processor(SimpleSpanProcessor(exporter))

    # Add LangWatch exporter
    _add_langwatch_exporter(provider, span_filter)


def _full_setup(
    span_filter: Optional[SpanFilter],
    span_processors: Optional[List[SpanProcessor]],
    trace_exporter: Optional[SpanExporter],
    instrumentors: Optional[Sequence],
) -> None:
    """Full OTel setup when no provider exists."""
    api_key = os.environ.get("LANGWATCH_API_KEY")
    endpoint = os.environ.get("LANGWATCH_ENDPOINT", "https://app.langwatch.ai")

    if api_key:
        # Use langwatch.setup() for proper LangWatch integration
        import langwatch

        langwatch.setup(
            api_key=api_key,
            endpoint_url=endpoint,
            instrumentors=instrumentors if instrumentors is not None else [],
            skip_open_telemetry_setup=True,
        )

        # Create our own provider with judge collector + LangWatch exporter
        provider = TracerProvider()
        provider.add_span_processor(judge_span_collector)

        if span_processors:
            for processor in span_processors:
                provider.add_span_processor(processor)

        if trace_exporter:
            exporter = trace_exporter
            if span_filter:
                exporter = FilteringSpanExporter(exporter, span_filter)
            provider.add_span_processor(SimpleSpanProcessor(exporter))

        _add_langwatch_exporter(provider, span_filter)

        trace.set_tracer_provider(provider)

        # Run instrumentors against our provider
        if instrumentors:
            for instrumentor in instrumentors:
                instrumentor.instrument(tracer_provider=provider)
    else:
        # No API key - minimal setup
        provider = TracerProvider()
        provider.add_span_processor(judge_span_collector)

        if span_processors:
            for processor in span_processors:
                provider.add_span_processor(processor)

        if trace_exporter:
            exporter = trace_exporter
            if span_filter:
                exporter = FilteringSpanExporter(exporter, span_filter)
            provider.add_span_processor(SimpleSpanProcessor(exporter))

        trace.set_tracer_provider(provider)
        logger.debug(
            "Created new TracerProvider with judge span collector (no LangWatch API key)"
        )


def _add_langwatch_exporter(
    provider: TracerProvider,
    span_filter: Optional[SpanFilter],
) -> None:
    """Add the LangWatch OTLP exporter to a provider."""
    api_key = os.environ.get("LANGWATCH_API_KEY")
    if not api_key:
        return

    endpoint = os.environ.get("LANGWATCH_ENDPOINT", "https://app.langwatch.ai")

    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
    except ImportError:
        logger.warning(
            "opentelemetry-exporter-otlp-proto-http not installed. "
            "LangWatch span export disabled."
        )
        return

    otlp_exporter = OTLPSpanExporter(
        endpoint=f"{endpoint}/api/otel/v1/traces",
        headers={"Authorization": f"Bearer {api_key}"},
    )

    if span_filter:
        exporter: SpanExporter = FilteringSpanExporter(otlp_exporter, span_filter)
    else:
        exporter = otlp_exporter

    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider.add_span_processor(BatchSpanProcessor(exporter))


def _reset_tracing_for_tests() -> None:
    """Resets the initialization flag. Only for testing purposes."""
    global _initialized
    _initialized = False
