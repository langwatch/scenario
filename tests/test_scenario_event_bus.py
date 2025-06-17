import pytest
from scenario.events import (
    ScenarioRunStartedEvent,
    ScenarioRunFinishedEvent,
    ScenarioRunStatus,
    ScenarioResults,
    Verdict,
    generate_batch_run_id,
    generate_scenario_id,
    generate_scenario_run_id,
)
from scenario.event_bus import ScenarioEventBus
from datetime import datetime

class MockEventReporter:
    def __init__(self):
        self.events = []
    
    async def post_event(self, event):
        self.events.append(event)

@pytest.mark.asyncio
async def test_scenario_event_bus_basic_flow():
    # Arrange
    reporter = MockEventReporter()
    bus = ScenarioEventBus(event_reporter=reporter)
    
    batch_run_id = generate_batch_run_id()
    scenario_id = generate_scenario_id()
    scenario_run_id = generate_scenario_run_id()
    
    # Act
    await bus.listen()
    
    start_event = ScenarioRunStartedEvent(
        batchRunId=batch_run_id,
        scenarioId=scenario_id,
        scenarioRunId=scenario_run_id,
        metadata={}
    )
    bus.publish(start_event)
    
    finish_event = ScenarioRunFinishedEvent(
        batchRunId=batch_run_id,
        scenarioId=scenario_id,
        scenarioRunId=scenario_run_id,
        status=ScenarioRunStatus.SUCCESS,
        results=ScenarioResults(
            verdict=Verdict.Success,
            reasoning="Test completed successfully"
        )
    )
    bus.publish(finish_event)
    
    await bus.drain()
    
    # Assert
    assert len(reporter.events) == 2
    
    # Verify all events have timestamps as integers
    for event in reporter.events:
        assert event.timestamp is not None
        assert isinstance(event.timestamp, int)
        assert event.timestamp > 0  # Should be a valid Unix timestamp
    
    # Verify start event was timestamped before finish event
    start_events = [e for e in reporter.events if isinstance(e, ScenarioRunStartedEvent)]
    finish_events = [e for e in reporter.events if isinstance(e, ScenarioRunFinishedEvent)]
    assert len(start_events) == 1
    assert len(finish_events) == 1
    assert start_events[0].timestamp <= finish_events[0].timestamp

@pytest.mark.asyncio
async def test_scenario_event_bus_handles_errors():
    # Arrange
    failure_count = 0
    
    class RetryEventReporter:
        def __init__(self, fail_times=2):
            self.events = []
            self.fail_times = fail_times
            self.attempt_counts = {}
            
        def _event_key(self, event):
            # Use a tuple of fields that uniquely identify the event
            return (getattr(event, "scenarioRunId", None), type(event).__name__)
        
        async def post_event(self, event):
            key = self._event_key(event)
            self.attempt_counts[key] = self.attempt_counts.get(key, 0) + 1
            
            if isinstance(event, ScenarioRunStartedEvent) and self.attempt_counts[key] <= self.fail_times:
                raise Exception(f"Simulated failure #{self.attempt_counts[key]}")
            
            self.events.append(event)
    
    reporter = RetryEventReporter()
    bus = ScenarioEventBus(event_reporter=reporter, max_retries=3)
    
    batch_run_id = generate_batch_run_id()
    scenario_id = generate_scenario_id()
    scenario_run_id = generate_scenario_run_id()
    
    # Act
    await bus.listen()
    
    # This event will fail twice then succeed
    start_event = ScenarioRunStartedEvent(
        batchRunId=batch_run_id,
        scenarioId=scenario_id,
        scenarioRunId=scenario_run_id,
        metadata={}
    )
    bus.publish(start_event)
    
    # This event should process normally
    finish_event = ScenarioRunFinishedEvent(
        batchRunId=batch_run_id,
        scenarioId=scenario_id,
        scenarioRunId=scenario_run_id,
        status=ScenarioRunStatus.SUCCESS,
        results=ScenarioResults(
            verdict=Verdict.Success,
            reasoning="Test completed successfully"
        )
    )
    bus.publish(finish_event)
    
    # Wait for processing to complete
    await bus.drain()
    
    # Assert
    assert len(reporter.events) == 2  # Both events should be recorded
    
    # Verify we have both types of events (order independent)
    assert any(isinstance(e, ScenarioRunStartedEvent) for e in reporter.events)
    assert any(isinstance(e, ScenarioRunFinishedEvent) for e in reporter.events)
    
    # Verify retry counts
    # There should be only one ScenarioRunStartedEvent, and it should have 3 attempts
    start_attempts = sum(
        count for key, count in reporter.attempt_counts.items()
        if key[1] == "ScenarioRunStartedEvent"
    )
    assert start_attempts == 3  # Failed twice, succeeded on third try

    # Find the key for the start event
    start_key = (scenario_run_id, "ScenarioRunStartedEvent")
    assert reporter.attempt_counts[start_key] == 3  # Failed twice, succeeded on third try 