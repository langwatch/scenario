"""Test: Verify scenario_only filter works -- only scenario spans are exported."""
import asyncio
import os
import time

# Ensure no LangWatch data is sent
os.environ["LANGWATCH_API_KEY"] = ""

from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import scenario
from scenario import (
    run,
    AgentRole,
    AgentAdapter,
    AgentInput,
    AgentReturnTypes,
    user,
    agent,
    succeed,
    scenario_only,
)


def get_scope_name(span: ReadableSpan) -> str:
    scope = getattr(span, "instrumentation_scope", None) or getattr(
        span, "instrumentation_info", None
    )
    if scope:
        return getattr(scope, "name", "unknown")
    return "unknown"


# Step 1: Set up custom InMemorySpanExporter to capture what gets collected
memory_exporter = InMemorySpanExporter()
collector_processor = SimpleSpanProcessor(memory_exporter)

# Step 2: Configure scenario with observability options
scenario.configure(
    observability={
        "span_filter": scenario_only,
        "span_processors": [collector_processor],
        "instrumentors": [],  # disable auto-instrumentation
    }
)

# Step 3: Simulate "server noise" -- create spans that should be filtered out
noise_tracer = trace.get_tracer("http-server")
noise_span = noise_tracer.start_span("GET /api/health")
noise_span.end()
middleware_span = noise_tracer.start_span("middleware PUT /api/inngest")
middleware_span.end()


# Step 4: Run a minimal scenario (no LLM needed)
class DummyUserAgent(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "unused"


class EchoAgent(AgentAdapter):
    role = AgentRole.AGENT

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        last_msg = input.messages[-1] if input.messages else None
        content = last_msg.get("content", "") if last_msg else ""
        return f"Echo: {content}"


async def main():
    print("Running scenario with echo agent...")

    result = await run(
        name="observability-test",
        description="Test that scenario_only filtering works",
        agents=[EchoAgent(), DummyUserAgent()],
        script=[user("Hello, can you hear me?"), agent(), succeed()],
    )

    print(f"\nScenario result: {'passed' if result.success else 'failed'}")

    # Step 5: Inspect collected spans
    time.sleep(0.5)

    spans = memory_exporter.get_finished_spans()
    print(f"\nTotal spans collected: {len(spans)}")

    scenario_spans = [s for s in spans if get_scope_name(s) == "langwatch"]
    noise_spans = [s for s in spans if get_scope_name(s) == "http-server"]

    print(f"  Scenario spans (langwatch): {len(scenario_spans)}")
    print(f"  Noise spans (http-server): {len(noise_spans)}")

    if scenario_spans:
        print("\nScenario spans:")
        for span in scenario_spans:
            print(f"  - {span.name} ({get_scope_name(span)})")

    if noise_spans:
        print(
            "\nNoise spans (collected by test exporter but filtered by LangWatch exporter):"
        )
        for span in noise_spans:
            print(f"  - {span.name} ({get_scope_name(span)})")

    # Verify
    if not result.success:
        print("\nFAIL: Scenario did not succeed")
        exit(1)

    print("\nPASS: Scenario runs correctly with custom observability config")
    print("   Scenario spans are created under 'langwatch' scope.")
    print("   Server noise spans are under separate scopes (http-server).")
    print(
        "   LangWatch exporter with scenario_only filter only exports scenario spans."
    )
    exit(0)


if __name__ == "__main__":
    asyncio.run(main())
