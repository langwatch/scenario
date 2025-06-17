import pytest
import respx
import logging
from scenario.event_reporter import EventReporter  # You will create this
from scenario.events import ScenarioRunStartedEvent

@pytest.mark.asyncio
async def test_post_event_sends_correct_request(caplog):
    # Arrange
    endpoint = "https://api.example.com/events"
    api_key = "test-api-key"
    event = ScenarioRunStartedEvent(
        batchRunId="batch-1",
        scenarioId="scenario-1",
        scenarioRunId="run-1",
        scenarioSetId=None,
        metadata={"foo": "bar"},
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
        assert b'"type":"RUN_STARTED"' in request.content
        # Check logs for success
        assert any("Event POST response status: 200" in m for m in caplog.messages)