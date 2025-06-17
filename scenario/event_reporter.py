import logging
import os
import httpx
from pydantic import BaseModel
from scenario.events import BaseScenarioEvent

class EventReporter:
    """
    Handles HTTP posting of scenario events to external endpoints.

    Single responsibility: Send events via HTTP to configured endpoints
    with proper authentication and error handling.

    Args:
        endpoint (str, optional): The URL to post events to. Defaults to SCENARIO_EVENTS_ENDPOINT env var.
        api_key (str, optional): The API key for authentication. Defaults to LANGWATCH_API_KEY env var.

    Example:
        reporter = EventReporter(endpoint="https://api.example.com/events", api_key="test-api-key")
        await reporter.post_event({"type": "RUN_STARTED", "foo": "bar"})
    """

    def __init__(self, endpoint=None, api_key=None):
        self.endpoint = endpoint or os.getenv("SCENARIO_EVENTS_ENDPOINT")
        self.api_key = api_key or os.getenv("LANGWATCH_API_KEY", "")
        self.logger = logging.getLogger("EventReporter")

    async def post_event(self, event: BaseScenarioEvent):
        """
        Posts an event to the configured endpoint.
        Logs success/failure but doesn't throw - event posting shouldn't break scenario execution.

        Args:
            event (BaseModel or dict): The event data to send.
        """
        event_type = getattr(event, "type", None)
        event_payload = event.model_dump_json()

        self.logger.debug(f"[{event_type}] Posting event: {event}")

        if not self.endpoint:
            self.logger.warning("No SCENARIO_EVENTS_ENDPOINT configured, skipping event posting")
            return

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    self.endpoint,
                    content=event_payload,
                    headers={
                        "Content-Type": "application/json",
                        "X-Auth-Token": self.api_key,
                    },
                )
            self.logger.debug(f"Event POST response status: {response.status_code}")
            self.logger.debug(f"View events at {response.url}")

            if response.status_code == 200:
                try:
                    data = response.json()
                    self.logger.debug(f"Event POST response: {data}")
                except Exception:
                    pass  # Don't fail if response isn't JSON
            else:
                self.logger.error(
                    f"Event POST failed: status={response.status_code}, reason={response.reason_phrase}, body={response.text}, event={event}"
                )
        except Exception as error:
            self.logger.error(f"Event POST error: {error}, event={event}, endpoint={self.endpoint}") 