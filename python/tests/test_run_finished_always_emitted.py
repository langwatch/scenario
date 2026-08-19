"""The SCENARIO_RUN_FINISHED event must reach the reporter on every run exit,
exactly once, even when the run fails or the finished-emit path itself raises.

Reproduces #922: a script-assertion failure whose finished-event construction
also raised left the run without a finished event, so the UI showed the run as
stuck forever.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List
from unittest.mock import patch

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario._events import ScenarioEvent
from scenario._events.event_reporter import EventReporter
from scenario.agent_adapter import AgentAdapter
from scenario.scenario_executor import ScenarioExecutor
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _CountingReporter(EventReporter):
    """Drop-in reporter that records every event instead of POSTing."""

    def __init__(self) -> None:
        super().__init__(endpoint="http://localhost", api_key="test")
        self.received: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent, http_client: Any = None) -> Dict[str, Any]:
        self.received.append(event)
        return {}


class _Agent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hello"


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


def _agents() -> List[AgentAdapter]:
    return [_Agent(), _User(), _Judge()]


def _failing_step(state: Any) -> None:
    raise AssertionError("intentional check failure")


def _cancelling_step(state: Any) -> None:
    raise asyncio.CancelledError()


def _patched_reporter(reporter: _CountingReporter):
    return patch(
        "scenario._events.event_bus.EventReporter",
        side_effect=lambda *args, **kwargs: reporter,
    )


def _finished_events(reporter: _CountingReporter) -> List[ScenarioEvent]:
    return [e for e in reporter.received if e.type_ == "SCENARIO_RUN_FINISHED"]


@pytest.mark.asyncio
async def test_finished_emitted_once_when_finished_emit_path_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#922 reproduction: the AssertionError from the script must propagate and
    the finished event must still be posted exactly once, even though the first
    attempt to emit it raises."""
    reporter = _CountingReporter()

    original_emit = ScenarioExecutor._emit_run_finished_event
    calls = {"count": 0}

    def flaky_emit(self: ScenarioExecutor, *args: Any, **kwargs: Any) -> None:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("induced finished-emit failure")
        original_emit(self, *args, **kwargs)

    monkeypatch.setattr(ScenarioExecutor, "_emit_run_finished_event", flaky_emit)

    with _patched_reporter(reporter):
        with pytest.raises(AssertionError, match="intentional check failure"):
            await scenario.arun(
                name="finished-emit-path-fails",
                description="finished event still posted when its emit fails once",
                agents=_agents(),
                script=[scenario.user("hi"), _failing_step],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )


@pytest.mark.asyncio
async def test_finished_emitted_once_on_plain_assertion_failure() -> None:
    reporter = _CountingReporter()

    with _patched_reporter(reporter):
        with pytest.raises(AssertionError, match="intentional check failure"):
            await scenario.arun(
                name="plain-assertion-failure",
                description="finished event posted once on assertion failure",
                agents=_agents(),
                script=[scenario.user("hi"), _failing_step],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )


@pytest.mark.asyncio
async def test_finished_emitted_when_the_run_started_emit_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The started-event emit runs before reset(), so the fallback result must
    not read timing or state attributes that do not exist yet. A raise there
    would leave the run with no terminal event, which is the #922 symptom."""
    reporter = _CountingReporter()

    def failing_started_emit(self: ScenarioExecutor, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("induced started-emit failure")

    monkeypatch.setattr(
        ScenarioExecutor, "_emit_run_started_event", failing_started_emit
    )

    with _patched_reporter(reporter):
        with pytest.raises(RuntimeError, match="induced started-emit failure"):
            await scenario.arun(
                name="started-emit-fails",
                description="finished event still posted when the started emit fails",
                agents=_agents(),
                script=[scenario.user("hi")],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )
    status = getattr(finished[0], "status")
    assert getattr(status, "value", str(status)) == "ERROR"


@pytest.mark.asyncio
async def test_finished_not_emitted_twice_when_a_subscriber_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`on_next` delivers to each subscriber in turn. A subscriber that raises
    after the bus already took the event must not cause a second one: the
    guard is set before the event reaches the stream."""
    reporter = _CountingReporter()

    original_emit = ScenarioExecutor._emit_event

    def emit_then_raise(self: ScenarioExecutor, event: ScenarioEvent) -> None:
        original_emit(self, event)
        if event.type_ == "SCENARIO_RUN_FINISHED":
            raise RuntimeError("a later subscriber raised")

    monkeypatch.setattr(ScenarioExecutor, "_emit_event", emit_then_raise)

    # A subscriber that never sees on_completed keeps its worker waiting, so
    # the stream has to complete even though publication raised.
    from rx.subject import Subject

    completions = {"count": 0}
    original_on_completed = Subject.on_completed

    def counting_on_completed(self: Subject) -> None:
        completions["count"] += 1
        return original_on_completed(self)

    monkeypatch.setattr(Subject, "on_completed", counting_on_completed)

    with _patched_reporter(reporter):
        # The script failure is what the caller sees: the emit failure is
        # deliberately discarded so the original assertion is not masked.
        with pytest.raises(AssertionError, match="intentional check failure"):
            await scenario.arun(
                name="subscriber-raises",
                description="one finished event even when a subscriber raises",
                agents=_agents(),
                script=[scenario.user("hi"), _failing_step],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )
    assert completions["count"] >= 1, "the event stream never completed"


@pytest.mark.asyncio
async def test_finished_emitted_when_pre_run_setup_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Voice connect and modality resolution run before the script does. A
    failure there is still a run that has to report itself as finished."""
    reporter = _CountingReporter()

    async def failing_connect(self: ScenarioExecutor) -> None:
        raise RuntimeError("induced voice connect failure")

    monkeypatch.setattr(ScenarioExecutor, "_voice_connect_all", failing_connect)

    with _patched_reporter(reporter):
        with pytest.raises(RuntimeError, match="induced voice connect failure"):
            await scenario.arun(
                name="pre-run-setup-fails",
                description="finished event still posted when setup fails",
                agents=_agents(),
                script=[scenario.user("hi")],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )
    status = getattr(finished[0], "status")
    assert getattr(status, "value", str(status)) == "ERROR"


@pytest.mark.asyncio
async def test_finished_emitted_on_cancelled_error() -> None:
    """CancelledError is a BaseException: it must still propagate, and the run
    must still report a finished event with status ERROR."""
    reporter = _CountingReporter()

    with _patched_reporter(reporter):
        with pytest.raises(asyncio.CancelledError):
            await scenario.arun(
                name="cancelled-run",
                description="finished event posted when the run is cancelled",
                agents=_agents(),
                script=[scenario.user("hi"), _cancelling_step],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )
    status = getattr(finished[0], "status")
    assert getattr(status, "value", str(status)) == "ERROR"


@pytest.mark.asyncio
async def test_finished_reaches_reporter_on_threaded_run_path() -> None:
    """scenario.run() executes on a worker thread and drains the bus in its
    finally block; the finished event must have reached the reporter by the
    time the raised assertion surfaces."""
    reporter = _CountingReporter()

    with _patched_reporter(reporter):
        with pytest.raises(AssertionError, match="intentional check failure"):
            await scenario.run(
                name="threaded-run-failure",
                description="finished event posted on the threaded run path",
                agents=_agents(),
                script=[scenario.user("hi"), _failing_step],
            )

    finished = _finished_events(reporter)
    assert len(finished) == 1, (
        f"Expected exactly one RUN_FINISHED, got {len(finished)}: "
        f"{[e.type_ for e in reporter.received]}"
    )
