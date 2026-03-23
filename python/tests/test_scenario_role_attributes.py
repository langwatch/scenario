"""Tests for scenario.role and scenario.run_id span attributes."""

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
    """Tests for scenario.role on agent call spans."""

    @pytest.mark.asyncio
    async def test_sets_role_on_user_agent_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """User agent span has scenario.role = 'User'."""
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
            assert attrs.get("scenario.role") == "User"

    @pytest.mark.asyncio
    async def test_sets_role_on_agent_under_test_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Agent-under-test span has scenario.role = 'Agent'."""
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
            assert attrs.get("scenario.role") == "Agent"

    @pytest.mark.asyncio
    async def test_sets_role_on_judge_agent_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Judge agent span has scenario.role = 'Judge'."""
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
            assert attrs.get("scenario.role") == "Judge"


class TestScenarioRunIdAttribute:
    """Tests for scenario.run_id on root (Scenario Turn) spans."""

    @pytest.mark.asyncio
    async def test_sets_run_id_on_root_span(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Root 'Scenario Turn' span has scenario.run_id set."""
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

        all_spans = in_memory_exporter.get_finished_spans()
        root_spans = [s for s in all_spans if s.name == "Scenario Turn"]
        assert len(root_spans) > 0, "Expected at least one Scenario Turn root span"

        for span in root_spans:
            attrs = dict(span.attributes or {})
            run_id = attrs.get("scenario.run_id")
            assert run_id is not None, f"Root span missing scenario.run_id"
            assert isinstance(run_id, str)
            assert run_id.startswith("scenariorun_")

    @pytest.mark.asyncio
    async def test_agent_spans_do_not_have_run_id(
        self, in_memory_exporter: _InMemorySpanExporter
    ):
        """Agent call spans should NOT have scenario.run_id (only root span has it)."""
        executor = ScenarioExecutor(
            name="run_id placement test",
            description="test run_id only on root",
            agents=[
                MockAgent(),
                MockUserSimulatorAgent(model="none"),
                MockJudgeAgent(model="none", criteria=["test criteria"]),
            ],
        )

        await executor.run()

        spans = _agent_spans(in_memory_exporter)
        for span in spans:
            attrs = dict(span.attributes or {})
            assert "scenario.run_id" not in attrs, f"Span {span.name} should not have scenario.run_id"


