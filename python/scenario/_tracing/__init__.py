"""
Tracing infrastructure for scenario testing.

This module sets up OpenTelemetry instrumentation with LangWatch,
registering the JudgeSpanCollector to capture spans for judge evaluation.

Importing this module triggers setup as a side-effect.
"""

from .setup import setup_observability
from .judge_span_collector import judge_span_collector, JudgeSpanCollector

# Trigger setup on import
setup_observability()

__all__ = [
    "judge_span_collector",
    "JudgeSpanCollector",
    "setup_observability",
]
