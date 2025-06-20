import pytest
from typing import List, Tuple

from scenario import JudgeAgent, UserSimulatorAgent
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, ScenarioResult
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

    async def post_event(self, event: ScenarioEvent) -> None:
        """Store events instead of posting them."""
        self.posted_events.append(event)


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

    start_events: List[ScenarioRunStartedEvent] = [e for e in events if isinstance(e, ScenarioRunStartedEvent)]
    finish_events: List[ScenarioRunFinishedEvent] = [e for e in events if isinstance(e, ScenarioRunFinishedEvent)]
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)]

    assert len(start_events) == 1
    assert len(finish_events) == 1
    assert len(snapshot_events) > 0


@pytest.mark.asyncio
async def test_start_event_structure(executed_events: ExecutedEventsFixture) -> None:
    """Start event should have correct structure and content."""
    events, executor = executed_events
    start_event: ScenarioRunStartedEvent = next(e for e in events if isinstance(e, ScenarioRunStartedEvent))

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
    finish_event: ScenarioRunFinishedEvent = next(e for e in events if isinstance(e, ScenarioRunFinishedEvent))

    assert finish_event.type_ == "SCENARIO_RUN_FINISHED"
    assert finish_event.batch_run_id == executor.batch_run_id
    assert finish_event.scenario_id == "test scenario"
    assert finish_event.scenario_run_id
    assert finish_event.scenario_set_id == "default"
    assert finish_event.timestamp > 0
    assert finish_event.status
    # Results are optional but should be valid if present
    if finish_event.results:
        assert hasattr(finish_event.results, 'reasoning')


@pytest.mark.asyncio
async def test_snapshot_events_structure(executed_events: ExecutedEventsFixture) -> None:
    """Snapshot events should have correct structure."""
    events, executor = executed_events
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)]

    for snapshot in snapshot_events:
        assert snapshot.type_ == "SCENARIO_MESSAGE_SNAPSHOT"
        assert snapshot.batch_run_id == executor.batch_run_id
        assert snapshot.scenario_id == "test scenario"
        assert snapshot.scenario_run_id
        assert snapshot.scenario_set_id == "default"
        assert snapshot.timestamp > 0
        assert isinstance(snapshot.messages, list)


@pytest.mark.asyncio
async def test_events_share_consistent_scenario_run_ids(executed_events: ExecutedEventsFixture) -> None:
    """All events should share the same scenario run ID."""
    events, _ = executed_events

    # Get the expected scenario run ID from the first event (since executor doesn't expose it)
    expected_scenario_run_id = events[0].scenario_run_id

    # Check that all events have the same scenario run ID
    for event in events:
        assert event.scenario_run_id == expected_scenario_run_id, f"Event {event.type_} has inconsistent scenario_run_id"


@pytest.mark.asyncio
async def test_events_share_consistent_batch_run_ids(executed_events: ExecutedEventsFixture) -> None:
    """All events should share the same batch run ID and match the executor."""
    events, executor = executed_events

    # Get the expected batch run ID from the executor
    expected_batch_run_id = executor.batch_run_id

    # Check that all events have the same batch run ID and match the executor
    for event in events:
        assert event.batch_run_id == expected_batch_run_id, f"Event {event.type_} has inconsistent batch_run_id"


@pytest.mark.asyncio
async def test_event_ordering(executed_events: ExecutedEventsFixture) -> None:
    """Events should be timestamped in order."""
    events, _ = executed_events

    start_event: ScenarioRunStartedEvent = next(e for e in events if isinstance(e, ScenarioRunStartedEvent))
    snapshot_events: List[ScenarioMessageSnapshotEvent] = [e for e in events if isinstance(e, ScenarioMessageSnapshotEvent)]
    finish_event: ScenarioRunFinishedEvent = next(e for e in events if isinstance(e, ScenarioRunFinishedEvent))

    assert start_event.timestamp <= snapshot_events[0].timestamp
    assert snapshot_events[-1].timestamp <= finish_event.timestamp
    assert start_event.timestamp <= finish_event.timestamp
