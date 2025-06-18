import logging
import os
import httpx
from typing import Optional
from .events import ScenarioEvent 

class EventReporter:
    """
    Handles HTTP posting of scenario events to external endpoints.

    Single responsibility: Send events via HTTP to configured endpoints
    with proper authentication and error handling.

    Args:
        endpoint (str, optional): The base URL to post events to. Defaults to SCENARIO_EVENTS_ENDPOINT env var.
        api_key (str, optional): The API key for authentication. Defaults to LANGWATCH_API_KEY env var.

    Example:
        event = {
            "type": "SCENARIO_RUN_STARTED",
            "batch_run_id": "batch-1",
            "scenario_id": "scenario-1", 
            "scenario_run_id": "run-1",
            "metadata": {
                "name": "test",
                "description": "test scenario"
            }
        }
        
        reporter = EventReporter(endpoint="https://api.example.com", api_key="test-api-key")
        await reporter.post_event(event)
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None):
        self.endpoint = endpoint or os.getenv("SCENARIO_EVENTS_ENDPOINT")
        self.api_key = api_key or os.getenv("LANGWATCH_API_KEY", "")
        self.logger = logging.getLogger("EventReporter")

    async def post_event(self, event: ScenarioEvent):
        """
        Posts an event to the configured endpoint.
        
        Args:
            event: A dictionary containing the event data
            
        Returns:
            None - logs success/failure internally
        """
        event_type = event.type_
        self.logger.debug(f"[{event_type}] Posting event: {event}")

        if not self.endpoint:
            self.logger.warning("No SCENARIO_EVENTS_ENDPOINT configured, skipping event posting")
            return

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    self.endpoint,
                    json=event.to_dict(),
                    headers={
                        "Content-Type": "application/json",
                        "X-Auth-Token": self.api_key
                    }
                )
                self.logger.debug(f"Event POST response status: {response.status_code}")
                
                if response.is_success:
                    data = response.json()
                    self.logger.debug(f"Event POST response: {data}")
                else:
                    error_text = response.text
                    self.logger.error(
                        f"Event POST failed: status={response.status_code}, "
                        f"reason={response.reason_phrase}, error={error_text}, "
                        # f"event={printable_event}"
                    )
        except Exception as error:
            self.logger.error(
                f"Event POST error: {error}, event={event}, endpoint={self.endpoint}") 