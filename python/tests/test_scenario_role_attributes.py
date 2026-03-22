"""Tests for langwatch.scenario.role and langwatch.scenario.run_id span attributes."""

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
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)


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


def _agent_spans(exporter: _InMemorySpanExporter) -> List[ReadableSpan]:
    """Return only the agent .call spans (not turn or root spans)."""
    return [s for s in exporter.get_finished_spans() if s.name.endswith(".call")]


class TestScenarioRoleAttribute:
    """Tests for langwatch.scenario.role on agent call spans."""

    @pytest.mark.asyncio
    async def test_sets_role_on_user_agent_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """User agent span has langwatch.scenario.role = 'User'."""
        executor = ScenarioExecutor(
            name="role test",
            description="test role attribute",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        user_spans = [s for s in spans if s.name == "MockUserSimulatorAgent.call"]
        assert len(user_spans) > 0, "Expected at least one user agent span"

        for span in user_spans:
            attrs = dict(span.attributes or {})
            assert attrs.get("langwatch.scenario.role") == "User"

    @pytest.mark.asyncio
    async def test_sets_role_on_agent_under_test_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Agent-under-test span has langwatch.scenario.role = 'Agent'."""
        executor = ScenarioExecutor(
            name="role test",
            description="test role attribute",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        agent_spans = [s for s in spans if s.name == "MockAgent.call"]
        assert len(agent_spans) > 0, "Expected at least one agent-under-test span"

        for span in agent_spans:
            attrs = dict(span.attributes or {})
            assert attrs.get("langwatch.scenario.role") == "Agent"

    @pytest.mark.asyncio
    async def test_sets_role_on_judge_agent_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Judge agent span has langwatch.scenario.role = 'Judge'."""
        executor = ScenarioExecutor(
            name="role test",
            description="test role attribute",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        judge_spans = [s for s in spans if s.name == "MockJudgeAgent.call"]
        assert len(judge_spans) > 0, "Expected at least one judge agent span"

        for span in judge_spans:
            attrs = dict(span.attributes or {})
            assert attrs.get("langwatch.scenario.role") == "Judge"


class TestScenarioRunIdAttribute:
    """Tests for langwatch.scenario.run_id on agent call spans."""

    @pytest.mark.asyncio
    async def test_sets_run_id_on_agent_spans(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """All agent call spans have langwatch.scenario.run_id set."""
        executor = ScenarioExecutor(
            name="run_id test",
            description="test run_id attribute",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        assert len(spans) >= 3, "Expected at least 3 agent call spans (user, agent, judge)"

        for span in spans:
            attrs = dict(span.attributes or {})
            run_id = attrs.get("langwatch.scenario.run_id")
            assert run_id is not None, (
                f"Span {span.name} missing langwatch.scenario.run_id"
            )
            assert isinstance(run_id, str)
            assert len(run_id) > 0

    @pytest.mark.asyncio
    async def test_run_id_is_consistent_across_agent_spans(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """All agent call spans within a single run share the same run_id."""
        executor = ScenarioExecutor(
            name="run_id consistency test",
            description="test run_id consistency",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        run_ids = {
            dict(span.attributes or {}).get("langwatch.scenario.run_id")
            for span in spans
        }
        assert len(run_ids) == 1, (
            f"Expected all agent spans to share one run_id, got {run_ids}"
        )
