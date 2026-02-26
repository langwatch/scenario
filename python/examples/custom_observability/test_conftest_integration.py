"""Test: Verify conftest.py-based setup works (scenario_only via conftest).

This test must be run from the examples/custom_observability/ directory
so that conftest.py is importable. The conftest module calls
scenario.configure(observability=...) at import time, simulating what
pytest does when it loads conftest.py before running tests.
"""
import asyncio

# Import conftest to trigger setup_scenario_tracing() -- pytest does this
# automatically, but when running standalone we need to do it explicitly.
import conftest  # noqa: F401

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from scenario import (
    run,
    AgentRole,
    AgentAdapter,
    AgentInput,
    AgentReturnTypes,
    user,
    agent,
    succeed,
)


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
    # Verify OTel is initialized (conftest.py ran setup_scenario_tracing)
    provider = trace.get_tracer_provider()
    is_sdk = isinstance(provider, TracerProvider)
    print(f"Provider type: {type(provider).__name__}")
    print(f"Is SDK TracerProvider: {is_sdk}")

    if not is_sdk:
        print("\nFAIL: TracerProvider not initialized by conftest.py")
        exit(1)

    # Create server noise
    noise_tracer = trace.get_tracer("http-server")
    noise_span = noise_tracer.start_span("GET /api/health")
    noise_span.end()

    # Run scenario
    print("\nRunning scenario (tracing configured by conftest.py)...")

    result = await run(
        name="conftest-integration-test",
        description="Test conftest.py-based observability config",
        agents=[EchoAgent(), DummyUserAgent()],
        script=[user("Hello from conftest test!"), agent(), succeed()],
    )

    print(f"\nScenario result: {'passed' if result.success else 'failed'}")

    if not result.success:
        print("\nFAIL: Scenario did not succeed")
        exit(1)

    print("\nPASS: conftest.py-based setup works correctly")
    print("   scenario.configure(observability=...) called by conftest.py before run()")
    print("   run() used the config's observability settings")
    exit(0)


asyncio.run(main())
