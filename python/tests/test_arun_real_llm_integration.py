"""Concurrent ``scenario.arun`` with real LLM-backed simulator + judge.

The customer relies on ``UserSimulatorAgent`` and ``JudgeAgent`` — both
hit an LLM under the hood via litellm. This test proves they work
correctly when multiple scenarios run concurrently on the same loop,
including that their LLM spans end up parented under the correct
Scenario Turn root and never leak between scenarios.

Requires ``OPENAI_API_KEY``. Uses ``gpt-5-mini`` per CLAUDE.md guidance.
"""

from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes


pytestmark = pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set"
)


scenario.configure(default_model="openai/gpt-5-mini")


class _EchoAgent(AgentAdapter):
    """Keeps the test cheap: the agent-under-test is a deterministic echo,
    so the LLM burn is only the simulator + judge calls."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        last = next(
            (m for m in reversed(input.messages) if m.get("role") == "user"),
            None,
        )
        raw = (last or {}).get("content") or ""
        text = raw if isinstance(raw, str) else ""
        return {"role": "assistant", "content": f"I heard you say: {text[:60]}"}


@pytest.mark.asyncio
async def test_concurrent_arun_with_real_simulator_and_judge():
    """Three concurrent scenarios, each with a full simulator+judge pipeline.

    Success criterion: all three return without raising a loop-affinity
    error, and every scenario's spans stay in that scenario's trace
    (invariant checked via the in-process span collector).
    """
    from scenario._tracing import judge_span_collector

    before_span_ids = {
        id(s) for s in (getattr(judge_span_collector, "_spans", []) or [])
    }

    async def one(i: int):
        return await scenario.arun(
            name=f"real-llm-{i}",
            description=(
                "User asks a simple question and is mostly happy with the "
                "echo, then asks one follow-up."
            ),
            agents=[
                _EchoAgent(),
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(
                    criteria=[
                        "The agent responded at least twice",
                        "The agent's response included something echoed from the user's words",
                    ],
                ),
            ],
            max_turns=4,
        )

    results = await asyncio.gather(*(one(i) for i in range(3)))

    # The judge output depends on LLM wording; we don't care whether it
    # says PASS or FAIL, only that it didn't blow up.
    for r in results:
        assert r is not None, "arun returned no result"

    all_spans = [
        s
        for s in (getattr(judge_span_collector, "_spans", []) or [])
        if id(s) not in before_span_ids
    ]
    assert all_spans, "expected some spans from the concurrent run"

    by_trace: dict[str, set[str]] = {}
    parents: list[tuple[str, str, str | None]] = []
    for span in all_spans:
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
        assert parent_id in by_trace[trace_id], (
            f"Span {span_id} in trace {trace_id} refers to parent "
            f"{parent_id} which is not in the same trace — spans from "
            "different concurrent scenarios leaked into each other."
        )

    # At least one distinct LiteLLM / langwatch span must show up per
    # scenario — i.e. ≥ 3 distinct trace ids in total from this run.
    distinct_traces = {t for t, _, _ in parents}
    assert len(distinct_traces) >= 3, (
        f"Expected ≥ 3 distinct traces (one per scenario), got "
        f"{len(distinct_traces)}: {distinct_traces}"
    )
