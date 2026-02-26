"""
Example conftest.py for custom observability configuration.

This is what a user would put in their project's conftest.py.
When pytest loads, it imports conftest before running any tests,
so setup_scenario_tracing() runs before any scenario.run() calls.
"""
import os

# Ensure no LangWatch data is sent in these examples
os.environ["LANGWATCH_API_KEY"] = ""

from scenario import setup_scenario_tracing, scenario_only

setup_scenario_tracing(
    span_filter=scenario_only,
    instrumentors=[],  # disable auto-instrumentation
)
