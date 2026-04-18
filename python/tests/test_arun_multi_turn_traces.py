"""Multi-turn concurrency test for ``scenario.arun``.

``ScenarioExecutor._new_turn`` creates a new LangWatch trace per turn.
Under concurrent ``arun``, two scenarios that each cycle through several
turns must:

- emit one root "Scenario Turn" span per turn per scenario;
- keep every span within the trace of its own turn;
- never parent a span under another scenario's turn root, even when
  turn boundaries interleave in wall-clock time.

The customer's core concern is that shared state (loop-bound
singletons) survives concurrency; the secondary concern is that the
telemetry pipeline stays faithful when many scenarios overlap. This
test covers the second.
"""

from __future__ import annotations

import asyncio
import os
from typing import List, Optional

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


@pytest.fixture
def in_memory_exporter():
    """Keep every emitted span in memory for the test duration.

    The scenario's own judge span collector is a shared singleton that
    gets pruned on each scenario's cleanup, so it's unsafe to use
    across concurrent scenarios. An owned ``InMemorySpanExporter``
    sees every finished span regardless of per-scenario cleanup.
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


class _EchoUser(AgentAdapter):
    role = AgentRole.USER

    def __init__(self, prompts: List[str]):
        self._prompts = prompts
        self._idx = 0

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        prompt = self._prompts[min(self._idx, len(self._prompts) - 1)]
        self._idx += 1
        return prompt


class _MeetingPoint:
    """Python 3.10-compatible stand-in for ``asyncio.Barrier(parties)``.

    Each ``wait()`` call bumps the counter and blocks until the
    expected number of parties have arrived, then releases them all.
    """

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
            # Someone never arrived — release anyway so the already-waiting
            # tasks can proceed rather than hang the suite.
            self._released.set()


class _TurnTrackingAgent(AgentAdapter):
    def __init__(self, label: str, barrier: Optional["_MeetingPoint"] = None):
        self._label = label
        self._barrier = barrier
        self._turn = 0

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        self._turn += 1
        # Synchronise scenarios at every agent turn so they actually
        # overlap on the event loop rather than running serially.
        if self._barrier is not None:
            await self._barrier.wait()
        return {"role": "assistant", "content": f"{self._label} turn {self._turn}"}


class _InstantJudge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="ok",
            passed_criteria=["ran to completion"],
        )


@pytest.mark.asyncio
async def test_multi_turn_traces_stay_isolated_under_concurrency(in_memory_exporter):
    """Two multi-turn scenarios launched on the same loop must keep their
    per-turn trace roots separate. Every non-root span's parent must
    live in the same trace."""
    prompts = ["hi first", "still there?", "great, bye"]

    async def one(label: str, barrier: _MeetingPoint):
        user = _EchoUser(list(prompts))
        agent = _TurnTrackingAgent(label=label, barrier=barrier)
        result = await scenario.arun(
            name=f"multi-turn-{label}",
            description=f"multi-turn scenario {label}",
            agents=[agent, user, _InstantJudge()],
            script=[
                scenario.user(prompts[0]),
                scenario.agent(),
                scenario.user(prompts[1]),
                scenario.agent(),
                scenario.user(prompts[2]),
                scenario.agent(),
                scenario.judge(),
            ],
        )
        return label, result

    barrier = _MeetingPoint(parties=2)
    results = await asyncio.gather(one("A", barrier), one("B", barrier))
    assert all(r.success for _, r in results), results

    snapshot = list(in_memory_exporter.get_finished_spans())
    assert snapshot, "exporter captured nothing from the run"

    by_trace: dict[str, set[str]] = {}
    parents: list[tuple[str, str, Optional[str]]] = []
    for span in snapshot:
        ctx = span.get_span_context()
        trace_id = format(ctx.trace_id, "032x")
        span_id = format(ctx.span_id, "016x")
        parent = span.parent
        parent_id = format(parent.span_id, "016x") if parent else None
        by_trace.setdefault(trace_id, set()).add(span_id)
        parents.append((trace_id, span_id, parent_id))

    for trace_id, span_id, parent_id in parents:
        if parent_id is None:
            continue
        siblings = by_trace.get(trace_id, set())
        assert parent_id in siblings, (
            f"Span {span_id} in trace {trace_id} points at parent "
            f"{parent_id} which lives in a different trace — this is "
            "the cross-pollination we must prevent."
        )


@pytest.mark.asyncio
async def test_each_turn_gets_its_own_trace_under_arun(in_memory_exporter):
    """The scenario executor opens one LangWatch trace per turn. After a
    3-turn scenario, at least 3 distinct trace_ids appear."""
    prompts = ["first", "second", "third"]

    await scenario.arun(
        name="three-turns",
        description="three turns single-scenario",
        agents=[_TurnTrackingAgent("solo"), _EchoUser(prompts), _InstantJudge()],
        script=[
            scenario.user(prompts[0]),
            scenario.agent(),
            scenario.user(prompts[1]),
            scenario.agent(),
            scenario.user(prompts[2]),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    snapshot = list(in_memory_exporter.get_finished_spans())
    turn_roots = {
        format(s.get_span_context().trace_id, "032x")
        for s in snapshot
        if s.name == "Scenario Turn"
    }

    assert len(turn_roots) >= 3, (
        f"Expected at least 3 distinct 'Scenario Turn' trace ids from a "
        f"3-turn scenario, got {len(turn_roots)}: {turn_roots}"
    )
