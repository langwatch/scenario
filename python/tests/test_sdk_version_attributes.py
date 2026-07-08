"""Unit tests for scenario SDK name+version stamped on trace spans.

Mirrors the TypeScript test in
``javascript/src/execution/__tests__/scenario-sdk-version-attribute.test.ts``
(merged PR #736).

AC from issue #744:
- Both attributes stamped on the top-level ``Scenario Turn`` span on EVERY run.
- ``scenario.sdk.name`` == ``"langwatch-scenario"``
- ``scenario.sdk.version`` == ``importlib.metadata.version("langwatch-scenario")``
- Version is NOT hardcoded — read from package metadata.
"""

from __future__ import annotations

import os
import re
from importlib.metadata import version as pkg_version

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import scenario
from scenario._tracing import ensure_tracing_initialized
from scenario._tracing.sdk_metadata import (
    ATTR_SCENARIO_SDK_NAME,
    ATTR_SCENARIO_SDK_VERSION,
    SCENARIO_SDK_NAME,
)
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


# ---------------------------------------------------------------------------
# Shared test helpers
# ---------------------------------------------------------------------------

class _EchoAgent(AgentAdapter):
    role = AgentRole.AGENT

    async def call(self, _input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "Hello, I can help you."}


class _EchoUser(AgentAdapter):
    role = AgentRole.USER

    async def call(self, _input: AgentInput) -> AgentReturnTypes:
        return "Hi there"


class _InstantJudge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, _input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="ok",
            passed_criteria=["ran to completion"],
        )


@pytest.fixture()
def in_memory_exporter():
    """Attach a fresh InMemorySpanExporter to the active tracer provider."""
    from opentelemetry import trace

    ensure_tracing_initialized(None)
    provider = trace.get_tracer_provider()
    exporter = InMemorySpanExporter()
    processor = SimpleSpanProcessor(exporter)
    if not hasattr(provider, "add_span_processor"):
        pytest.skip(f"Active tracer provider {type(provider)} is not mutable")
    provider.add_span_processor(processor)  # type: ignore[attr-defined]  # hasattr guard above confirms TracerProvider is a concrete SDK provider with add_span_processor; the abstract base omits it
    try:
        yield exporter
    finally:
        processor.shutdown()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sdk_name_and_version_stamped_on_scenario_turn_span(in_memory_exporter):
    """Both scenario.sdk.name and scenario.sdk.version appear on the turn span."""
    result = await scenario.arun(
        name="sdk-version-attr-test",
        description="verify SDK identity attributes on the Scenario Turn span",
        agents=[_EchoAgent(), _EchoUser(), _InstantJudge()],
        script=[
            scenario.user("hello"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    assert result.success, f"scenario failed unexpectedly: {result.reasoning}"

    finished = in_memory_exporter.get_finished_spans()
    turn_spans = [s for s in finished if s.name == "Scenario Turn"]
    assert turn_spans, "no 'Scenario Turn' spans were emitted"

    expected_version = pkg_version("langwatch-scenario")

    for span in turn_spans:
        assert ATTR_SCENARIO_SDK_NAME in span.attributes, (
            f"Span '{span.name}' is missing attribute '{ATTR_SCENARIO_SDK_NAME}'"
        )
        assert ATTR_SCENARIO_SDK_VERSION in span.attributes, (
            f"Span '{span.name}' is missing attribute '{ATTR_SCENARIO_SDK_VERSION}'"
        )
        assert span.attributes[ATTR_SCENARIO_SDK_NAME] == SCENARIO_SDK_NAME, (
            f"Expected sdk.name={SCENARIO_SDK_NAME!r}, "
            f"got {span.attributes[ATTR_SCENARIO_SDK_NAME]!r}"
        )
        assert span.attributes[ATTR_SCENARIO_SDK_VERSION] == expected_version, (
            f"Expected sdk.version={expected_version!r}, "
            f"got {span.attributes[ATTR_SCENARIO_SDK_VERSION]!r}"
        )


@pytest.mark.asyncio
async def test_sdk_version_matches_package_metadata(in_memory_exporter):
    """scenario.sdk.version on the span equals importlib.metadata.version()."""
    await scenario.arun(
        name="sdk-version-metadata-match",
        description="sdk.version on span must match importlib.metadata",
        agents=[_EchoAgent(), _EchoUser(), _InstantJudge()],
        script=[
            scenario.user("hi"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    finished = in_memory_exporter.get_finished_spans()
    turn_spans = [s for s in finished if s.name == "Scenario Turn"]
    assert turn_spans

    emitted = turn_spans[0].attributes.get(ATTR_SCENARIO_SDK_VERSION)
    assert isinstance(emitted, str) and emitted, (
        f"sdk.version must be a non-empty string, got {emitted!r}"
    )
    # Must be semver-shaped (N.N.N...)
    assert re.match(r"^\d+\.\d+\.\d+", emitted), (
        f"sdk.version {emitted!r} is not semver-shaped"
    )
    # Must equal what importlib.metadata reports
    assert emitted == pkg_version("langwatch-scenario"), (
        f"Emitted version {emitted!r} != installed version "
        f"{pkg_version('langwatch-scenario')!r}"
    )


@pytest.mark.asyncio
async def test_sdk_attrs_stamped_on_every_turn_span_in_multi_turn(in_memory_exporter):
    """SDK attributes appear on ALL turn spans, not just the first."""
    turn_count = 0

    class _CountingJudge(AgentAdapter):
        role = AgentRole.JUDGE

        async def call(self, _input: AgentInput) -> AgentReturnTypes:
            nonlocal turn_count
            turn_count += 1
            if turn_count >= 2:
                return ScenarioResult(
                    success=True,
                    messages=[],
                    reasoning="done after 2 turns",
                    passed_criteria=["multi-turn complete"],
                )
            return "keep going"

    await scenario.arun(
        name="sdk-version-multi-turn",
        description="sdk.* present on every turn span across multiple turns",
        agents=[_EchoAgent(), _EchoUser(), _CountingJudge()],
        script=[scenario.proceed()],
    )

    finished = in_memory_exporter.get_finished_spans()
    turn_spans = [s for s in finished if s.name == "Scenario Turn"]
    assert len(turn_spans) >= 2, (
        f"Expected at least 2 turn spans for multi-turn, got {len(turn_spans)}"
    )

    expected_version = pkg_version("langwatch-scenario")
    for span in turn_spans:
        assert span.attributes.get(ATTR_SCENARIO_SDK_NAME) == SCENARIO_SDK_NAME
        assert span.attributes.get(ATTR_SCENARIO_SDK_VERSION) == expected_version
