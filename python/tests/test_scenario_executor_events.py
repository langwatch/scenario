import logging
import pytest
from typing import Any, cast as _cast, List, Tuple, Dict
from unittest.mock import patch

from scenario import JudgeAgent, UserSimulatorAgent, succeed
from scenario._generated.langwatch_api_client.lang_watch_api_client.types import Unset
from scenario.agent_adapter import AgentAdapter
from scenario.scenario_state import ScenarioState
from scenario.types import AgentInput, ChatCompletionMessageParamWithTrace, ScenarioResult
from scenario.scenario_executor import ScenarioExecutor
from scenario._events import (
    ScenarioEvent,
    ScenarioRunStartedEvent,
    ScenarioRunFinishedEvent,
    ScenarioMessageSnapshotEvent,
    ScenarioEventBus,
    EventReporter,
)


class MockJudgeAgent(JudgeAgent):
    async def call(self, input: AgentInput) -> ScenarioResult:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="test reasoning",
            passed_criteria=["test criteria"],
        )


class MockUserSimulatorAgent(UserSimulatorAgent):
    async def call(self, input: AgentInput) -> str:
        return "Hi, I'm a user"


class MockAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> str:
        return "Hey, how can I help you?"


class MockEventReporter(EventReporter):
    """Mock event reporter that doesn't make HTTP calls."""

    def __init__(self) -> None:
        # Don't call super().__init__() to avoid setting up HTTP client
        self.posted_events: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        """Store events instead of posting them."""
        self.posted_events.append(event)
        return {}


# Type alias to reduce repetition
ExecutedEventsFixture = Tuple[List[ScenarioEvent], ScenarioExecutor]


@pytest.fixture
def executor() -> ScenarioExecutor:
    """Create a test executor with mock agents and event bus."""
    # Create event bus with mock reporter to avoid HTTP calls
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    return ScenarioExecutor(
        name="test scenario",
        description="test description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
        event_bus=event_bus,
    )


@pytest.fixture
async def executed_events(executor: ScenarioExecutor) -> ExecutedEventsFixture:
    """Run scenario and collect events."""
    events: List[ScenarioEvent] = []
    executor.events.subscribe(events.append)
    await executor.run()
    return events, executor


@pytest.mark.asyncio
async def test_emits_required_events(executed_events: ExecutedEventsFixture) -> None:
    """Should emit start, finish, and snapshot events."""
    events, _ = executed_events

    start_events: List[ScenarioRunStartedEvent] = [
        e for e in events if isinstance(e, ScenarioRunStartedEvent)
    ]
    finish_events: List[ScenarioRunFinishedEvent] = [
        e for e in events if isinstance(e, ScenarioRunFinishedEvent)
    ]
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [
        e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)
    ]

    assert len(start_events) == 1
    assert len(finish_events) == 1
    assert len(snapshot_events) > 0


@pytest.mark.asyncio
async def test_start_event_structure(executed_events: ExecutedEventsFixture) -> None:
    """Start event should have correct structure and content."""
    events, executor = executed_events
    start_event: ScenarioRunStartedEvent = next(
        e for e in events if isinstance(e, ScenarioRunStartedEvent)
    )

    assert start_event.type_ == "SCENARIO_RUN_STARTED"
    assert start_event.batch_run_id == executor.batch_run_id
    assert start_event.scenario_id == "test scenario"
    assert start_event.scenario_run_id
    assert start_event.scenario_set_id == "default"
    assert start_event.timestamp > 0
    assert start_event.metadata.name == "test scenario"
    assert start_event.metadata.description == "test description"


@pytest.mark.asyncio
async def test_finish_event_structure(executed_events: ExecutedEventsFixture) -> None:
    """Finish event should have correct structure and results."""
    events, executor = executed_events
    finish_event: ScenarioRunFinishedEvent = next(
        e for e in events if isinstance(e, ScenarioRunFinishedEvent)
    )

    assert finish_event.type_ == "SCENARIO_RUN_FINISHED"
    assert finish_event.batch_run_id == executor.batch_run_id
    assert finish_event.scenario_id == "test scenario"
    assert finish_event.scenario_run_id
    assert finish_event.scenario_set_id == "default"
    assert finish_event.timestamp > 0
    assert finish_event.status
    # Results are optional but should be valid if present
    if finish_event.results:
        assert hasattr(finish_event.results, "reasoning")


@pytest.mark.asyncio
async def test_snapshot_events_structure(
    executed_events: ExecutedEventsFixture,
) -> None:
    """Snapshot events should have correct structure."""
    events, executor = executed_events
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [
        e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)
    ]

    for snapshot in snapshot_events:
        assert snapshot.type_ == "SCENARIO_MESSAGE_SNAPSHOT"
        assert snapshot.batch_run_id == executor.batch_run_id
        assert snapshot.scenario_id == "test scenario"
        assert snapshot.scenario_run_id
        assert snapshot.scenario_set_id == "default"
        assert snapshot.timestamp > 0
        assert isinstance(snapshot.messages, list)


@pytest.mark.asyncio
async def test_events_share_consistent_scenario_run_ids(
    executed_events: ExecutedEventsFixture,
) -> None:
    """All events should share the same scenario run ID."""
    events, _ = executed_events

    # Get the expected scenario run ID from the first event (since executor doesn't expose it)
    expected_scenario_run_id = events[0].scenario_run_id

    # Check that all events have the same scenario run ID
    for event in events:
        assert (
            event.scenario_run_id == expected_scenario_run_id
        ), f"Event {event.type_} has inconsistent scenario_run_id"


@pytest.mark.asyncio
async def test_events_share_consistent_batch_run_ids(
    executed_events: ExecutedEventsFixture,
) -> None:
    """All events should share the same batch run ID and match the executor."""
    events, executor = executed_events

    # Get the expected batch run ID from the executor
    expected_batch_run_id = executor.batch_run_id

    # Check that all events have the same batch run ID and match the executor
    for event in events:
        assert (
            event.batch_run_id == expected_batch_run_id
        ), f"Event {event.type_} has inconsistent batch_run_id"


@pytest.mark.asyncio
async def test_event_ordering(executed_events: ExecutedEventsFixture) -> None:
    """Events should be timestamped in order."""
    events, _ = executed_events

    start_event: ScenarioRunStartedEvent = next(
        e for e in events if isinstance(e, ScenarioRunStartedEvent)
    )
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [
        e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)
    ]
    finish_event: ScenarioRunFinishedEvent = next(
        e for e in events if isinstance(e, ScenarioRunFinishedEvent)
    )

    assert start_event.timestamp <= snapshot_events[0].timestamp
    assert snapshot_events[-1].timestamp <= finish_event.timestamp
    assert start_event.timestamp <= finish_event.timestamp


class FailingAgent(AgentAdapter):
    """Agent that raises an exception."""

    async def call(self, input: AgentInput) -> str:
        raise RuntimeError("Simulated agent failure")


@pytest.mark.asyncio
async def test_emits_error_event_on_exception() -> None:
    """Should emit ScenarioRunFinishedEvent with ERROR status when agent throws."""
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    executor = ScenarioExecutor(
        name="error scenario",
        description="test error handling",
        agents=[
            FailingAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test"]),
        ],
        event_bus=event_bus,
    )

    events: List[ScenarioEvent] = []
    executor.events.subscribe(events.append)

    with pytest.raises(RuntimeError, match="Simulated agent failure"):
        await executor.run()

    # Verify we still got the finish event with ERROR status
    finish_events = [e for e in events if isinstance(e, ScenarioRunFinishedEvent)]
    assert len(finish_events) == 1, "Should emit finish event even on error"

    finish_event = finish_events[0]
    assert finish_event.status.value == "ERROR"
    results = finish_event.results
    assert not isinstance(results, Unset) and results is not None
    reasoning = results.reasoning
    assert isinstance(reasoning, str)
    assert "Simulated agent failure" in reasoning


@pytest.mark.asyncio
async def test_error_includes_agent_class_name() -> None:
    """Error message should identify which agent threw the exception."""
    import scenario

    executor = ScenarioExecutor(
        name="agent error tagging",
        description="test agent identification in errors",
        agents=[
            FailingAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test"]),
        ],
        script=[
            scenario.user(),
            scenario.agent(),  # This will call FailingAgent and throw
        ],
    )

    with pytest.raises(RuntimeError) as exc_info:
        await executor.run()

    # Error should include the agent class name
    assert "FailingAgent" in str(exc_info.value)


@pytest.mark.asyncio
async def test_user_metadata_appears_in_run_started_event() -> None:
    """User metadata should appear in RUN_STARTED event's additional_properties."""
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    executor = ScenarioExecutor(
        name="metadata scenario",
        description="test metadata",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
        event_bus=event_bus,
        metadata={"promptId": "abc-123", "environment": "staging"},
    )

    events: List[ScenarioEvent] = []
    executor.events.subscribe(events.append)
    await executor.run()

    start_event: ScenarioRunStartedEvent = next(
        e for e in events if isinstance(e, ScenarioRunStartedEvent)
    )

    metadata_dict = start_event.metadata.to_dict()
    assert metadata_dict["promptId"] == "abc-123"
    assert metadata_dict["environment"] == "staging"
    assert metadata_dict["name"] == "metadata scenario"
    assert metadata_dict["description"] == "test metadata"


@pytest.mark.asyncio
async def test_name_and_description_take_precedence_over_metadata() -> None:
    """Config name/description should take precedence over same keys in metadata."""
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    executor = ScenarioExecutor(
        name="real name",
        description="real description",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test criteria"]),
        ],
        event_bus=event_bus,
        metadata={"name": "overridden", "description": "overridden"},
    )

    events: List[ScenarioEvent] = []
    executor.events.subscribe(events.append)
    await executor.run()

    start_event: ScenarioRunStartedEvent = next(
        e for e in events if isinstance(e, ScenarioRunStartedEvent)
    )

    assert start_event.metadata.name == "real name"
    assert start_event.metadata.description == "real description"
    metadata_dict = start_event.metadata.to_dict()
    assert metadata_dict["name"] == "real name"
    assert metadata_dict["description"] == "real description"


# ---------------------------------------------------------------------------
# AC1 / AC4b / AC3 / AC5 — executor-level regression tests
# Ref: specs/empty-content-turn-snapshot.feature
# ---------------------------------------------------------------------------


def _make_empty_turn_executor() -> ScenarioExecutor:
    """Return an executor whose script injects an empty-content user turn then
    immediately succeeds.  The snapshot emitter fires after the inject step —
    that is the crash site under the buggy code."""
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    def _inject_empty_user_turn(state: ScenarioState) -> None:
        # Directly append a falsy-content user message — simulates what the
        # voice pipeline does when STT returns "" for silence.
        state.messages.append(
            _cast(
                ChatCompletionMessageParamWithTrace,
                {"role": "user", "content": ""},
            )
        )

    return ScenarioExecutor(
        name="voice empty turn scenario",
        description="STT returns empty string for silence",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test"]),
        ],
        event_bus=event_bus,
        script=[
            _inject_empty_user_turn,  # injects "" user turn; snapshot fires after
            succeed("voice run completed"),
        ],
    )


@pytest.mark.asyncio
async def test_run_completes_with_empty_user_turn() -> None:
    """AC1/AC4b — specs/empty-content-turn-snapshot.feature: run() must return a ScenarioResult, not raise ValueError, when state contains an empty-content user turn.

    The snapshot assertion pins AC4b: if the converter raise were reintroduced the
    emitter would swallow it, emit no snapshot, and this assertion would fail.
    """
    executor = _make_empty_turn_executor()
    events: List[ScenarioEvent] = []
    executor.events.subscribe(events.append)
    result = await executor.run()
    assert isinstance(result, ScenarioResult)
    assert result.success is True
    assert any(
        isinstance(e, ScenarioMessageSnapshotEvent) for e in events
    ), "ScenarioMessageSnapshotEvent must be emitted — silent swallow means the fix is broken"


@pytest.mark.asyncio
async def test_snapshot_emitter_failure_degrades_to_warning(caplog: pytest.LogCaptureFixture) -> None:
    """AC3 — specs/empty-content-turn-snapshot.feature: a failure inside the snapshot emitter must degrade to a logged warning, not abort run()."""
    mock_reporter = MockEventReporter()
    event_bus = ScenarioEventBus(event_reporter=mock_reporter)

    executor = ScenarioExecutor(
        name="snapshot failure scenario",
        description="force snapshot to raise",
        agents=[
            MockAgent(),
            MockUserSimulatorAgent(model="none"),
            MockJudgeAgent(model="none", criteria=["test"]),
        ],
        event_bus=event_bus,
        script=[
            lambda state: None,  # harmless step; snapshot fires after — we monkeypatch it to raise
            succeed("run should survive snapshot error"),
        ],
    )

    with patch(
        "scenario.scenario_executor.convert_messages_to_api_client_messages",
        side_effect=ValueError("forced serialization failure"),
    ):
        with caplog.at_level(logging.WARNING, logger="scenario"):
            result = await executor.run()

    assert isinstance(result, ScenarioResult), "run() must return a result even when snapshot emitter raises"
    assert any(
        "forced serialization failure" in record.message or "forced serialization failure" in str(record.exc_info)
        for record in caplog.records
        if record.levelno >= logging.WARNING
    ), "A WARNING must be logged when the snapshot emitter fails"


@pytest.mark.asyncio
async def test_empty_user_turn_state_unchanged_after_snapshot() -> None:
    """AC5 — specs/empty-content-turn-snapshot.feature: _state.messages must still contain the empty-content user turn unchanged after snapshot emission (fix is telemetry-only)."""
    executor = _make_empty_turn_executor()

    # We need to inspect _state AFTER the snapshot fires but BEFORE the run
    # returns.  Use the event subscription: on the first snapshot event, record
    # the executor state.  The snapshot fires synchronously inside run(), so
    # by the time run() returns the state has already been observed.
    captured_messages_at_snapshot: List[Any] = []

    def _on_event(event: ScenarioEvent) -> None:
        if isinstance(event, ScenarioMessageSnapshotEvent) and not captured_messages_at_snapshot:
            # Snapshot has just been emitted — record a copy of messages now
            captured_messages_at_snapshot.extend(list(executor._state.messages))

    executor.events.subscribe(_on_event)

    await executor.run()

    # The empty-content user turn must still be present in _state.
    # _make_empty_turn_executor injects exactly 1 message before succeed() fires.
    assert len(captured_messages_at_snapshot) == 1, (
        "_state.messages must have exactly 1 message after the inject step "
        "(nothing dropped or added by the snapshot path)"
    )
    assert any(
        msg.get("role") == "user" and msg.get("content") == ""
        for msg in captured_messages_at_snapshot
    ), "_state.messages must contain the empty-content user turn unchanged after snapshot emission"
