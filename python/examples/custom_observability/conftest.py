"""
Example conftest.py for custom observability configuration.

This is what a user would put in their project's conftest.py.
When pytest loads, it imports conftest before running any tests,
so scenario.configure() runs before any scenario.run() calls.
"""
import os

# Ensure no LangWatch data is sent in these examples
os.environ["LANGWATCH_API_KEY"] = ""

import scenario
from scenario import scenario_only

scenario.configure(
    observability={
        "span_filter": scenario_only,
        "instrumentors": [],  # disable auto-instrumentation
    }
)
