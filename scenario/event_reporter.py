import logging
import os

from .langwatch_api_client.lang_watch_api_client.client import Client as LangWatchClient
from .langwatch_api_client.lang_watch_api_client.api.default import post_api_scenario_events

class EventReporter:
    """
    Handles HTTP posting of scenario events to external endpoints using the generated LangWatch API client.

    Single responsibility: Send events via HTTP to configured endpoints
    with proper authentication and error handling.

    Args:
        endpoint (str, optional): The base URL to post events to. Defaults to SCENARIO_EVENTS_ENDPOINT env var.
        api_key (str, optional): The API key for authentication. Defaults to LANGWATCH_API_KEY env var.

    Example:
        from langwatch_api_client.lang_watch_api_client.models import PostApiScenarioEventsBodyType0
        from langwatch_api_client.lang_watch_api_client.models.post_api_scenario_events_body_type_0_metadata import PostApiScenarioEventsBodyType0Metadata
        
        metadata = PostApiScenarioEventsBodyType0Metadata(name="test", description="test scenario")
        event = PostApiScenarioEventsBodyType0(
            type_="SCENARIO_RUN_STARTED",
            batch_run_id="batch-1",
            scenario_id="scenario-1", 
            scenario_run_id="run-1",
            metadata=metadata
        )
        
        reporter = EventReporter(endpoint="https://api.langwatch.ai", api_key="test-api-key")
        await reporter.post_event(event)
    """

    def __init__(self, endpoint=None, api_key=None):
        self.endpoint = endpoint or os.getenv("SCENARIO_EVENTS_ENDPOINT")
        self.api_key = api_key or os.getenv("LANGWATCH_API_KEY", "")
        self.logger = logging.getLogger("EventReporter")

        # Set up the generated API client with proper authentication headers
        self.langwatch_client = LangWatchClient(
            base_url=self.endpoint,
            headers={"X-Auth-Token": self.api_key}
        )

    async def post_event(self, event):
        """
        Posts an event to the LangWatch API using the generated client.
        
        Args:
            event: A PostApiScenarioEventsBodyType event object with proper type and metadata
            
        Returns:
            None - logs success/failure internally
            
        Note:
            Uses the generated post_api_scenario_events function which handles serialization
            and makes the actual HTTP request to /api/scenario-events endpoint.
        """
        event_type = getattr(event, "type_", "UNKNOWN")  # Note: generated models use type_ not type
        self.logger.debug(f"[{event_type}] Posting event: {event}")

        if not self.endpoint:
            self.logger.warning("No SCENARIO_EVENTS_ENDPOINT configured, skipping event posting")
            return

        try:
            response = await post_api_scenario_events.asyncio_detailed(
                client=self.langwatch_client,
                body=event
            )
            self.logger.debug(f"Event POST response status: {response.status_code}")
        except Exception as error:
            self.logger.error(f"Event POST error: {error}, event={event}, endpoint={self.endpoint}") 