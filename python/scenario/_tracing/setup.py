"""
Sets up OpenTelemetry span collection for scenario testing.

Single responsibility: Register the judge span collector with the tracer provider.
"""

import logging
from typing import Optional

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from .judge_span_collector import judge_span_collector


logger = logging.getLogger("scenario.tracing")

_setup_complete = False


def setup_observability() -> Optional[TracerProvider]:
    """
    Registers the judge span collector with the existing tracer provider.

    This function is idempotent - calling it multiple times has no effect
    after the first successful setup.

    Note: This does NOT call langwatch.setup() - that is handled by the
    scenario_executor when creating traces. This only adds our span collector
    to capture spans for judge evaluation.

    Returns:
        The TracerProvider if setup succeeded, or None if already set up
    """
    global _setup_complete

    if _setup_complete:
        return None

    _setup_complete = True

    # Get the existing tracer provider or create one
    existing_provider = trace.get_tracer_provider()

    # If there's already a TracerProvider configured, add our processor to it
    if isinstance(existing_provider, TracerProvider):
        existing_provider.add_span_processor(judge_span_collector)
        logger.debug("Added judge span collector to existing TracerProvider")
        return existing_provider

    # Otherwise create a new one with our collector
    # (langwatch.trace() in scenario_executor will handle its own setup)
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(judge_span_collector)
    trace.set_tracer_provider(tracer_provider)
    logger.debug("Created new TracerProvider with judge span collector")

    return tracer_provider
