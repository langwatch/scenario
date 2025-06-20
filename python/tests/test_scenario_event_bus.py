import pytest
import time
from rx import from_iterable # type: ignore
from scenario._events.events import (
    ScenarioRunStartedEvent,
    ScenarioRunStartedEventMetadata,
    ScenarioRunFinishedEvent,
    ScenarioRunFinishedEventStatus,
    ScenarioRunFinishedEventResults,
    ScenarioRunFinishedEventVerdict,
    ScenarioMessageSnapshotEvent,
    ScenarioEvent,
)
from scenario._events import ScenarioEventBus
from scenario._events.messages import UserMessage
from scenario._events.event_reporter import EventReporter
from typing import List, Any, Dict

class MockEventReporter(EventReporter):
    def __init__(self):
        self.events: List[Any] = []

    async def post_event(self, event: Any):
        self.events.append(event)

@pytest.mark.asyncio
async def test_scenario_event_bus_basic_flow():
    # Arrange
    reporter = MockEventReporter()
    bus = ScenarioEventBus(event_reporter=reporter)

    batch_run_id = "batch-123"
    scenario_id = "scenario-456"
    scenario_run_id = "run-789"

    # Create events to emit
    metadata = ScenarioRunStartedEventMetadata(
        name="test-scenario",
        description="Test scenario description"
    )

    start_event = ScenarioRunStartedEvent(
        batch_run_id=batch_run_id,
        scenario_id=scenario_id,
        scenario_run_id=scenario_run_id,
        metadata=metadata,
        timestamp=int(time.time() * 1000),
    )

    message_event = ScenarioMessageSnapshotEvent(
        batch_run_id=batch_run_id,
        scenario_id=scenario_id,
        scenario_run_id=scenario_run_id,
        messages=[UserMessage(id="1", role="user", content="Hello, how are you?")],
        timestamp=int(time.time() * 1000),
    )

    results = ScenarioRunFinishedEventResults(
        verdict=ScenarioRunFinishedEventVerdict.SUCCESS,
        met_criteria=["criteria1"],
        unmet_criteria=[],
        reasoning="Test completed successfully",
    )

    finish_event = ScenarioRunFinishedEvent(
        batch_run_id=batch_run_id,
        scenario_id=scenario_id,
        scenario_run_id=scenario_run_id,
        status=ScenarioRunFinishedEventStatus.SUCCESS,
        results=results,
        timestamp=int(time.time() * 1000),
    )

    # Create Observable stream with our events
    events = [start_event, message_event, finish_event]
    event_stream = from_iterable(events)

    # Act - Subscribe to the event stream
    bus.subscribe_to_events(event_stream)

    # Wait for all events to be processed - drain() is now synchronous
    bus.drain()

    # Assert
    assert len(reporter.events) == 3

    # Verify all events have timestamps as integers
    for event in reporter.events:
        assert event.timestamp is not None
        assert isinstance(event.timestamp, int)
        assert event.timestamp > 0  # Should be a valid Unix timestamp

    # Verify we have all event types (order may vary due to async processing)
    start_events = [e for e in reporter.events if isinstance(e, ScenarioRunStartedEvent)]
    message_events = [e for e in reporter.events if isinstance(e, ScenarioMessageSnapshotEvent)]
    finish_events = [e for e in reporter.events if isinstance(e, ScenarioRunFinishedEvent)]
    assert len(start_events) == 1
    assert len(finish_events) == 1
    assert len(message_events) == 1
    # Note: Can't reliably test timestamp ordering due to async processing

@pytest.mark.asyncio
async def test_scenario_event_bus_handles_errors():
    # Arrange
    class RetryEventReporter(EventReporter):
        def __init__(self, fail_times: int = 2):
            self.events: List[ScenarioEvent] = []
            self.fail_times = fail_times
            self.attempt_counts: Dict[tuple[str | None, str], int] = {}

        def _event_key(self, event: ScenarioEvent):
            # Use a tuple of fields that uniquely identify the event
            return (getattr(event, "scenario_run_id", None), type(event).__name__)

        async def post_event(self, event: ScenarioEvent):
            key = self._event_key(event)
            self.attempt_counts[key] = self.attempt_counts.get(key, 0) + 1

            if isinstance(event, ScenarioRunStartedEvent) and self.attempt_counts[key] <= self.fail_times:
                raise Exception(f"Simulated failure #{self.attempt_counts[key]}")

            self.events.append(event)

    reporter = RetryEventReporter()
    bus = ScenarioEventBus(event_reporter=reporter, max_retries=3)

    batch_run_id = "batch-123"
    scenario_id = "scenario-456"
    scenario_run_id = "run-789"

    # Create events to emit
    metadata = ScenarioRunStartedEventMetadata(
        name="test-scenario",
        description="Test scenario description"
    )

    # This event will fail twice then succeed
    start_event = ScenarioRunStartedEvent(
        batch_run_id=batch_run_id,
        scenario_id=scenario_id,
        scenario_run_id=scenario_run_id,
        metadata=metadata,
        timestamp=int(time.time() * 1000),
    )

    results = ScenarioRunFinishedEventResults(
        verdict=ScenarioRunFinishedEventVerdict.FAILURE,
        met_criteria=[],
        unmet_criteria=["criteria1"],
        reasoning="Test completed successfully"
    )

    # This event should process normally
    finish_event = ScenarioRunFinishedEvent(
        batch_run_id=batch_run_id,
        scenario_id=scenario_id,
        scenario_run_id=scenario_run_id,
        status=ScenarioRunFinishedEventStatus.SUCCESS,
        results=results,
        timestamp=int(time.time() * 1000),
    )

    # Create Observable stream with our events
    events = [start_event, finish_event]
    event_stream = from_iterable(events)

    # Act - Subscribe to the event stream
    bus.subscribe_to_events(event_stream)

    # Wait for processing to complete - drain() is now synchronous
    bus.drain()

    # Assert
    assert len(reporter.events) == 2  # Both events should be recorded

    # Verify we have both types of events (order independent)
    assert any(isinstance(e, ScenarioRunStartedEvent) for e in reporter.events)
    assert any(isinstance(e, ScenarioRunFinishedEvent) for e in reporter.events)

    # Verify retry counts
    start_key = (scenario_run_id, "ScenarioRunStartedEvent")
    assert reporter.attempt_counts[start_key] == 3  # Failed twice, succeeded on third try

    finish_key = (scenario_run_id, "ScenarioRunFinishedEvent")
    assert reporter.attempt_counts[finish_key] == 1  # Should succeed on first try