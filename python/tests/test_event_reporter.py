import pytest
import respx
import logging
import time
from _pytest.logging import LogCaptureFixture
from scenario._events.event_reporter import EventReporter
from scenario._events.events import (
    ScenarioRunStartedEvent,
    ScenarioRunStartedEventMetadata,
)


@pytest.mark.asyncio
async def test_post_event_sends_correct_request(caplog: LogCaptureFixture) -> None:
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
        # Fix the endpoint to match the actual POST URL from EventReporter
        route = mock.post(f"{endpoint}/api/scenario-events").respond(200, json={"ok": True})

        # Act
        with caplog.at_level(logging.DEBUG):
            await reporter.post_event(event)

        # Assert
        assert route.called
        request: httpx.Request = route.calls[0].request # type: ignore
        assert request.headers["X-Auth-Token"] == api_key
        assert request.headers["Content-Type"] == "application/json"
        assert (
            b'"type": "SCENARIO_RUN_STARTED"' in request.content
            or b'"type":"SCENARIO_RUN_STARTED"' in request.content
        )
        # Check logs for success
        assert any("POST response status: 200" in m for m in caplog.messages)
