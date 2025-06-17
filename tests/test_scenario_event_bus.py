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
    
    # Generate IDs for this test run
    batch_run_id = generate_batch_run_id()
    scenario_id = generate_scenario_id()
    scenario_run_id = generate_scenario_run_id()
    
    # Act
    await bus.listen()  # Start listening for events
    
    # Publish start event
    start_event = ScenarioRunStartedEvent(
        batchRunId=batch_run_id,
        scenarioId=scenario_id,
        scenarioRunId=scenario_run_id,
        metadata={}
    )
    bus.publish(start_event)
    
    # Publish finish event
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
    assert len(reporter.events) == 2
    assert isinstance(reporter.events[0], ScenarioRunStartedEvent)
    assert isinstance(reporter.events[1], ScenarioRunFinishedEvent)
    assert reporter.events[0].scenarioRunId == scenario_run_id
    assert reporter.events[1].scenarioRunId == scenario_run_id 