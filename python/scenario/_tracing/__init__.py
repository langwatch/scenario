"""
Tracing infrastructure for scenario testing.

This module provides configurable OpenTelemetry instrumentation.
Tracing is initialized lazily on the first run() call, or explicitly
via setup_scenario_tracing().
"""

from .setup import setup_scenario_tracing, ensure_tracing_initialized, _reset_tracing_for_tests
from .judge_span_collector import judge_span_collector, JudgeSpanCollector
from .filters import scenario_only, with_custom_scopes, SpanFilter

__all__ = [
    "judge_span_collector",
    "JudgeSpanCollector",
    "setup_scenario_tracing",
    "ensure_tracing_initialized",
    "scenario_only",
    "with_custom_scopes",
    "SpanFilter",
]
