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
        endpoint (str, optional): The base URL to post events to. Defaults to LANGWATCH_ENDPOINT env var.
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

        reporter = EventReporter(endpoint="https://api.langwatch.ai", api_key="test-api-key")
        await reporter.post_event(event)
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None):
        self.endpoint = endpoint or os.getenv("LANGWATCH_ENDPOINT")
        self.api_key = api_key or os.getenv("LANGWATCH_API_KEY", "")
        self.logger = logging.getLogger(__name__)

    async def post_event(self, event: ScenarioEvent):
        """
        Posts an event to the configured endpoint.

        Args:
            event: A dictionary containing the event data

        Returns:
            None - logs success/failure internally
        """
        event_type = event.type_
        self.logger.info(f"[{event_type}] Publishing event ({event.scenario_run_id})")

        if not self.endpoint:
            self.logger.warning(
                "No LANGWATCH_ENDPOINT configured, skipping event posting"
            )
            return

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.endpoint}/api/scenario-events",
                    json=event.to_dict(),
                    headers={
                        "Content-Type": "application/json",
                        "X-Auth-Token": self.api_key,
                    },
                )
                self.logger.info(f"[{event_type}] POST response status: {response.status_code} ({event.scenario_run_id})")
                
                if response.is_success:
                    data = response.json()
                    self.logger.info(f"[{event_type}] POST response: {data} ({event.scenario_run_id})")
                else:
                    error_text = response.text
                    self.logger.error(
                        f"[{event_type}] Event POST failed: status={response.status_code}, "
                        f"reason={response.reason_phrase}, error={error_text}, "
                        f"event={event}"
                    )
        except Exception as error:
            self.logger.error(
                f"[{event_type}] Event POST error: {error}, event={event}, endpoint={self.endpoint}") 
