"""Tests for langwatch.origin attribute on scenario root spans."""

import pytest
from typing import List, Sequence

import scenario
from scenario import JudgeAgent, UserSimulatorAgent
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, ScenarioResult

from scenario.scenario_executor import ScenarioExecutor

from opentelemetry import trace
from opentelemetry.util._once import Once
from opentelemetry.sdk.trace import TracerProvider, ReadableSpan
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult


class _InMemorySpanExporter(SpanExporter):
    """Simple in-memory span exporter for testing."""

    def __init__(self):
        self._spans: List[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self._spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def get_finished_spans(self) -> List[ReadableSpan]:
        return list(self._spans)

    def clear(self) -> None:
        self._spans.clear()


class MockJudgeAgent(JudgeAgent):
    async def call(self, input: AgentInput) -> scenario.AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="test reasoning",
            passed_criteria=["test criteria"],
        )


class MockUserSimulatorAgent(UserSimulatorAgent):
    async def call(self, input: AgentInput) -> scenario.AgentReturnTypes:
        return "Hi, I'm a user"


class MockAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "Hey, how can I help you?"}


def _reset_otel():
    """Force-reset the global OTel tracer provider singleton."""
    trace._TRACER_PROVIDER_SET_ONCE = Once()
    trace._TRACER_PROVIDER = None
    trace._PROXY_TRACER_PROVIDER = trace.ProxyTracerProvider()


@pytest.fixture
def in_memory_exporter():
    """Set up an in-memory span exporter to capture spans for assertion."""
    _reset_otel()
    exporter = _InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    yield exporter
    provider.shutdown()
    _reset_otel()


class TestLangwatchScopeAttribute:
    """Tests for langwatch.origin = 'simulation' on root spans."""

    @pytest.mark.asyncio
    async def test_sets_langwatch_scope_simulation_on_root_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """The root span created by _new_turn has langwatch.origin = 'simulation'."""
        executor = ScenarioExecutor(
            name="scope test",
            description="test langwatch.origin attribute",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        result = await executor.run()
        assert result.success

        spans = in_memory_exporter.get_finished_spans()
        turn_spans = [s for s in spans if s.name == "Scenario Turn"]
        assert len(turn_spans) > 0, "Expected at least one 'Scenario Turn' span"

        for span in turn_spans:
            attrs = dict(span.attributes or {})
            assert "langwatch.origin" in attrs, (
                f"Root span should have 'langwatch.origin' attribute. "
                f"Found attributes: {list(attrs.keys())}"
            )
            assert attrs["langwatch.origin"] == "simulation", (
                f"langwatch.origin should be 'simulation', got '{attrs.get('langwatch.origin')}'"
            )

    @pytest.mark.asyncio
    async def test_scope_attribute_persists_across_turns(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Each new turn creates a new root span, all have langwatch.origin = 'simulation'."""

        class MultiTurnJudge(JudgeAgent):
            call_count = 0

            async def call(self, input: AgentInput) -> scenario.AgentReturnTypes:
                self.call_count += 1
                if self.call_count >= 2:
                    return ScenarioResult(
                        success=True,
                        messages=[],
                        reasoning="done",
                        passed_criteria=["test criteria"],
                    )
                return []

        executor = ScenarioExecutor(
            name="multi-turn scope test",
            description="test langwatch.origin persists across turns",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MultiTurnJudge(model="none", criteria=["test criteria"]),
            ],
        )

        result = await executor.run()
        assert result.success

        spans = in_memory_exporter.get_finished_spans()
        turn_spans = [s for s in spans if s.name == "Scenario Turn"]
        assert len(turn_spans) >= 2, (
            f"Expected at least 2 turn spans for multi-turn scenario, got {len(turn_spans)}"
        )

        for i, span in enumerate(turn_spans):
            attrs = dict(span.attributes or {})
            assert attrs.get("langwatch.origin") == "simulation", (
                f"Turn span {i} missing langwatch.origin = 'simulation'. "
                f"Got: {attrs.get('langwatch.origin')}"
            )
