import pytest
import respx
import logging
import time
from scenario.events.event_reporter import EventReporter  # You will create this
from scenario.events.events import (
    ScenarioRunStartedEvent,
    ScenarioRunStartedEventMetadata,
)


@pytest.mark.asyncio
async def test_post_event_sends_correct_request(caplog):
    # Arrange
    endpoint = "https://api.langwatch.ai"
    api_key = "test-api-key"

    # Create metadata using the proper model
    metadata = ScenarioRunStartedEventMetadata(
        name="test-name",
        description="test-description",
    )

    event = ScenarioRunStartedEvent(
        batch_run_id="batch-1",
        scenario_id="scenario-1",
        scenario_run_id="run-1",
        metadata=metadata,
        timestamp=int(time.time() * 1000),
    )

    reporter = EventReporter(endpoint=endpoint, api_key=api_key)

    with respx.mock as mock:
        route = mock.post(endpoint).respond(200, json={"ok": True})

        # Act
        with caplog.at_level(logging.DEBUG):
            await reporter.post_event(event)

        # Assert
        assert route.called
        request = route.calls[0].request
        assert request.headers["X-Auth-Token"] == api_key
        assert request.headers["Content-Type"] == "application/json"
        assert (
            b'"type": "SCENARIO_RUN_STARTED"' in request.content
            or b'"type":"SCENARIO_RUN_STARTED"' in request.content
        )
        # Check logs for success
        assert any("Event POST response status: 200" in m for m in caplog.messages)
