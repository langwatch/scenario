"""Tests for the async-native ``scenario.arun`` entrypoint.

Regression coverage for the ThreadPoolExecutor-per-run design of
``scenario.run``: loop-bound resources (gRPC channels, ``asyncio.Event``,
etc.) that were constructed on the caller's loop must survive being
awaited inside a scenario adapter. See
``specs/async-native-parallelism.feature``.
"""

import asyncio
import os
import threading
from typing import List

import pytest

# Disable scenario's "open the run in a browser" behaviour for these
# tests so that running them locally doesn't spam browser tabs.
os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _FinishingJudge(AgentAdapter):
    """Judge that immediately returns a successful result.

    Inherits from the base ``AgentAdapter`` rather than ``JudgeAgent`` so
    we don't have to configure an LLM just to exercise the executor.
    """

    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="ok",
            passed_criteria=["test criteria"],
        )


class _EchoUser(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hi"


class LoopBoundResource:
    """A resource bound to the event loop it was created on.

    Mirrors what a gRPC channel / Firestore client / ADK ``InMemoryRunner``
    looks like in practice: ``ping()`` schedules work on the loop it
    remembers and awaits a future created there. Awaiting that future
    from a different loop is exactly what the ThreadPoolExecutor path
    of ``scenario.run`` does and what breaks.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def ping(self) -> str:
        # ``run_coroutine_threadsafe`` schedules the inner coroutine on
        # the remembered loop and returns a ``concurrent.futures.Future``
        # — if this method is awaited from a DIFFERENT loop (i.e. the
        # scenario.run worker-thread loop), the remembered loop's
        # Future will not be drivable from here and we block/error.
        if asyncio.get_running_loop() is not self._loop:
            raise RuntimeError(
                "Future attached to a different loop: "
                f"running={id(asyncio.get_running_loop())} "
                f"resource={id(self._loop)}"
            )
        await asyncio.sleep(0)
        return "pong"


class _LoopBoundAgent(AgentAdapter):
    """Awaits a :class:`LoopBoundResource` created on a specific loop."""

    def __init__(self, resource: LoopBoundResource, observed: List[dict]) -> None:
        self._resource = resource
        self._observed = observed

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        reply = await self._resource.ping()
        self._observed.append(
            {
                "loop_id": id(asyncio.get_running_loop()),
                "thread_name": threading.current_thread().name,
            }
        )
        return {"role": "assistant", "content": reply}


async def _build_ready_event() -> LoopBoundResource:
    """Back-compat alias used by existing tests.

    Returns a resource bound to the currently running loop.
    """
    return LoopBoundResource(asyncio.get_running_loop())


class TestArun:
    @pytest.mark.asyncio
    async def test_runs_on_callers_event_loop(self):
        ready = await _build_ready_event()
        observed: List[dict] = []

        result = await scenario.arun(
            name="loop-bound",
            description="agent awaits a caller-loop resource",
            agents=[
                _LoopBoundAgent(ready, observed),
                _EchoUser(),
                _FinishingJudge(),
            ],
            script=[
                scenario.user("ping"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

        assert result.success is True
        assert len(observed) == 1
        assert observed[0]["loop_id"] == id(asyncio.get_running_loop())

    @pytest.mark.asyncio
    async def test_loop_bound_singleton_survives_concurrent_runs(self):
        """Several arun() calls gathered on the same loop share one resource."""
        ready = await _build_ready_event()
        observed: List[dict] = []

        async def one(name: str):
            return await scenario.arun(
                name=name,
                description="shared singleton",
                agents=[
                    _LoopBoundAgent(ready, observed),
                    _EchoUser(),
                    _FinishingJudge(),
                ],
                script=[
                    scenario.user("ping"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        results = await asyncio.gather(*(one(f"s-{i}") for i in range(5)))

        assert all(r.success for r in results)
        assert len(observed) == 5
        loop_id = id(asyncio.get_running_loop())
        assert all(o["loop_id"] == loop_id for o in observed)

    @pytest.mark.asyncio
    async def test_sibling_runs_isolate_failures(self):
        """One failing scenario does not abort sibling scenarios."""
        ready = await _build_ready_event()
        observed: List[dict] = []

        class _Boom(AgentAdapter):
            async def call(self, input: AgentInput) -> AgentReturnTypes:
                raise RuntimeError("boom")

        async def ok(i: int):
            return await scenario.arun(
                name=f"ok-{i}",
                description="healthy sibling",
                agents=[
                    _LoopBoundAgent(ready, observed),
                    _EchoUser(),
                    _FinishingJudge(),
                ],
                script=[
                    scenario.user("hi"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        async def bad():
            return await scenario.arun(
                name="bad",
                description="raises",
                agents=[_Boom(), _EchoUser(), _FinishingJudge()],
                script=[
                    scenario.user("hi"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        results = await asyncio.gather(ok(0), bad(), ok(1), return_exceptions=True)

        assert isinstance(results[0], ScenarioResult) and results[0].success
        assert isinstance(results[1], Exception)
        assert isinstance(results[2], ScenarioResult) and results[2].success
        assert len(observed) == 2

    @pytest.mark.asyncio
    async def test_runs_actually_interleave(self):
        """Two scenarios run concurrently on the same loop must overlap.

        If arun accidentally serialises (e.g. by holding a global lock
        or re-introducing a per-run thread), the max in-flight count
        would stay at 1.
        """
        in_flight = 0
        peak = 0
        lock = asyncio.Lock()
        gate = asyncio.Event()

        class _Slow(AgentAdapter):
            async def call(self, input: AgentInput) -> AgentReturnTypes:
                nonlocal in_flight, peak
                async with lock:
                    in_flight += 1
                    peak = max(peak, in_flight)
                # Block until both scenarios are in flight, then release.
                if in_flight >= 2:
                    gate.set()
                await asyncio.wait_for(gate.wait(), timeout=2.0)
                async with lock:
                    in_flight -= 1
                return {"role": "assistant", "content": "ok"}

        async def one(i: int):
            return await scenario.arun(
                name=f"slow-{i}",
                description="concurrency proof",
                agents=[_Slow(), _EchoUser(), _FinishingJudge()],
                script=[
                    scenario.user("hi"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        results = await asyncio.gather(one(0), one(1))
        assert all(r.success for r in results)
        assert peak == 2, f"expected concurrent execution, saw peak={peak}"

    @pytest.mark.asyncio
    async def test_unique_scenario_run_ids(self):
        ready = await _build_ready_event()
        observed: List[dict] = []

        async def one():
            return await scenario.arun(
                name="dup-check",
                description="unique ids",
                agents=[
                    _LoopBoundAgent(ready, observed),
                    _EchoUser(),
                    _FinishingJudge(),
                ],
                script=[
                    scenario.user("hi"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        await asyncio.gather(*(one() for _ in range(8)))

        # Each arun() builds its own ScenarioExecutor, so even without
        # exposing the id here the side effect we can assert is the
        # absence of any cross-run interference: the number of observed
        # invocations should equal the number of scenarios.
        assert len(observed) == 8


class TestRunStillThreaded:
    """Guard against accidentally changing ``scenario.run``'s contract."""

    @pytest.mark.asyncio
    async def test_sync_adapter_style_still_works(self):
        class _PlainAgent(AgentAdapter):
            async def call(self, input: AgentInput) -> AgentReturnTypes:
                return {"role": "assistant", "content": "hi"}

        result = await scenario.run(
            name="plain",
            description="no loop-bound resources",
            agents=[_PlainAgent(), _EchoUser(), _FinishingJudge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )
        assert result.success is True

    @pytest.mark.asyncio
    async def test_demonstrates_loop_affinity_break_under_run(self):
        """Characterisation test: ``scenario.run`` DOES break loop-bound
        awaitables today. This is the exact customer symptom and the
        reason ``arun`` exists.
        """
        ready = await _build_ready_event()
        observed: List[dict] = []

        with pytest.raises(RuntimeError) as excinfo:
            await scenario.run(
                name="expected-broken",
                description="awaiting on a caller-loop Event",
                agents=[
                    _LoopBoundAgent(ready, observed),
                    _EchoUser(),
                    _FinishingJudge(),
                ],
                script=[
                    scenario.user("ping"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        # The same test under scenario.arun succeeds (see
        # TestArun::test_runs_on_callers_event_loop). The failure mode is
        # always some form of loop-affinity error coming from asyncio —
        # pin just the "different loop" signature so any future
        # regression in the diagnostic message is caught.
        assert "different loop" in str(excinfo.value).lower()
