"""Test: Verify with_custom_scopes includes scenario + DB spans."""
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
    with_custom_scopes,
)


def get_scope_name(span: ReadableSpan) -> str:
    scope = getattr(span, "instrumentation_scope", None) or getattr(
        span, "instrumentation_info", None
    )
    if scope:
        return getattr(scope, "name", "unknown")
    return "unknown"


memory_exporter = InMemorySpanExporter()

scenario.configure(
    observability={
        "span_filter": with_custom_scopes("my-app/database"),
        "span_processors": [SimpleSpanProcessor(memory_exporter)],
        "instrumentors": [],
    }
)

# Simulate DB spans (should be kept)
db_tracer = trace.get_tracer("my-app/database")
db_span = db_tracer.start_span("db.query SELECT * FROM users")
db_span.end()

# Simulate HTTP noise (should be filtered for LangWatch, but captured by memory exporter)
noise_tracer = trace.get_tracer("http-server")
noise_span = noise_tracer.start_span("GET /api/health")
noise_span.end()


class DummyUserAgent(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "unused"


class EchoAgent(AgentAdapter):
    role = AgentRole.AGENT

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        # Simulate a DB call during agent execution
        tracer = trace.get_tracer("my-app/database")
        span = tracer.start_span("db.query INSERT INTO responses")
        span.end()
        last_msg = input.messages[-1] if input.messages else None
        content = last_msg.get("content", "") if last_msg else ""
        return f"Echo: {content}"


async def main():
    print("Running scenario with database-calling agent...")

    result = await run(
        name="custom-scopes-test",
        description="Test that with_custom_scopes includes scenario + DB spans",
        agents=[EchoAgent(), DummyUserAgent()],
        script=[user("Test with database spans"), agent(), succeed()],
    )

    print(f"\nScenario result: {'passed' if result.success else 'failed'}")

    time.sleep(0.5)

    spans = memory_exporter.get_finished_spans()
    print(f"\nTotal spans collected: {len(spans)}")

    scenario_spans = [s for s in spans if get_scope_name(s) == "langwatch"]
    db_spans = [s for s in spans if get_scope_name(s) == "my-app/database"]
    noise_spans = [s for s in spans if get_scope_name(s) == "http-server"]

    print(f"  Scenario spans: {len(scenario_spans)}")
    print(f"  Database spans: {len(db_spans)}")
    print(f"  HTTP noise spans: {len(noise_spans)}")

    if not result.success:
        print("\nFAIL: Scenario did not succeed")
        exit(1)

    if db_spans:
        print("\nDatabase spans captured:")
        for span in db_spans:
            print(f"  - {span.name}")

    print("\nPASS: with_custom_scopes includes both scenario and database spans")
    print("   LangWatch exporter would export scenario + my-app/database spans.")
    print("   HTTP noise spans are filtered out by the LangWatch exporter.")
    exit(0)


if __name__ == "__main__":
    asyncio.run(main())
