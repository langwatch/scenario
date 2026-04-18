"""Adapter-created spans parent under the correct Scenario Turn under
concurrent ``scenario.arun``.

When users instrument their adapter via ``langwatch.span(...)`` (or by
an OTel instrumentor) those spans must land inside THEIR scenario's
trace, not some sibling's. The ADK integration test shows this works
in practice; this test isolates the invariant without the ADK runtime
so CI can run it without Gemini.
"""

from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

import langwatch
import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


@pytest.fixture
def in_memory_exporter():
    """Attach an in-memory exporter to the active tracer provider for the
    duration of the test. This keeps captured spans even after the
    scenario's own cleanup runs.

    Scenario lazily installs its own ``TracerProvider`` when the first
    ``run``/``arun`` fires, but we need to attach the exporter
    beforehand. Force the init with ``ensure_tracing_initialized`` so
    the global provider is concrete before we mutate it.
    """
    from opentelemetry import trace
    from scenario._tracing import ensure_tracing_initialized

    ensure_tracing_initialized(None)
    provider = trace.get_tracer_provider()
    exporter = InMemorySpanExporter()
    processor = SimpleSpanProcessor(exporter)
    if not hasattr(provider, "add_span_processor"):
        pytest.skip(f"Active tracer provider {type(provider)} is not mutable")
    provider.add_span_processor(processor)  # type: ignore[attr-defined]
    try:
        yield exporter
    finally:
        processor.shutdown()


class _MeetingPoint:
    """Python 3.10-compatible stand-in for ``asyncio.Barrier(parties)``."""

    def __init__(self, parties: int):
        self._parties = parties
        self._arrived = 0
        self._released = asyncio.Event()

    async def wait(self, timeout: float = 5.0) -> None:
        self._arrived += 1
        if self._arrived >= self._parties:
            self._released.set()
        try:
            await asyncio.wait_for(self._released.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._released.set()


class _InstrumentedAgent(AgentAdapter):
    """Emits a nested user-owned span inside its call."""

    def __init__(self, label: str, barrier: "_MeetingPoint | None" = None):
        self._label = label
        self._barrier = barrier

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        reply = f"{self._label} done"
        with langwatch.span(name=f"user_work.{self._label}") as s:
            s.set_attributes({"user.label": self._label})
            # Synchronise across sibling scenarios so two user spans
            # overlap in wall-clock time — makes cross-contamination
            # detectable if present.
            if self._barrier is not None:
                await self._barrier.wait()
        return {"role": "assistant", "content": reply}


class _User(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hi"


class _Judge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["t"]
        )


@pytest.mark.asyncio
async def test_adapter_user_span_parents_to_scenario_turn(in_memory_exporter):
    """Under concurrent arun, each adapter's user span must end up
    parented inside that adapter's scenario, not its sibling's."""
    barrier = _MeetingPoint(parties=2)

    async def one(label: str):
        return await scenario.arun(
            name=f"user-span-{label}",
            description=f"instrumented scenario {label}",
            agents=[_InstrumentedAgent(label, barrier), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    results = await asyncio.gather(one("A"), one("B"))
    assert all(r.success for r in results)

    new_spans = list(in_memory_exporter.get_finished_spans())

    user_spans = [s for s in new_spans if s.name.startswith("user_work.")]
    span_names = [s.name for s in new_spans]
    assert len(user_spans) == 2, (
        f"expected 2 user spans, got {len(user_spans)}. "
        f"Captured span names: {span_names}"
    )

    # Build trace_id → (span_id → name).
    by_trace: dict[str, dict[str, str]] = {}
    for s in new_spans:
        ctx = s.get_span_context()
        trace_id = format(ctx.trace_id, "032x")
        span_id = format(ctx.span_id, "016x")
        by_trace.setdefault(trace_id, {})[span_id] = s.name

    for s in user_spans:
        ctx = s.get_span_context()
        trace_id = format(ctx.trace_id, "032x")
        assert s.parent is not None, (
            f"user span {s.name} has no parent — it should be a child "
            "of the Scenario Turn root"
        )
        parent_id = format(s.parent.span_id, "016x")
        parent_name = by_trace.get(trace_id, {}).get(parent_id)
        assert parent_name is not None, (
            f"user span {s.name} (trace {trace_id}) parents at {parent_id} "
            "which is NOT in its own trace — cross-scenario leak."
        )
        # The parent should be the adapter's own _InstrumentedAgent.call
        # or the Scenario Turn root; never a sibling's user_work.*.
        assert not parent_name.startswith("user_work."), (
            f"user span {s.name} parented under ANOTHER user span "
            f"({parent_name}) — that's leakage between concurrent scenarios."
        )

    # Each scenario's user span must live in a different trace.
    user_trace_ids = {
        format(s.get_span_context().trace_id, "032x") for s in user_spans
    }
    assert len(user_trace_ids) == 2, (
        f"two concurrent scenarios should yield 2 distinct trace ids "
        f"for user spans, got {user_trace_ids}"
    )
