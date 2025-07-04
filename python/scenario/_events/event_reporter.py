import logging
import httpx
from typing import Optional, Dict, Any
from .events import ScenarioEvent
from .event_alert_message_logger import EventAlertMessageLogger
from scenario.config import LangWatchSettings


class EventReporter:
    """
    Handles HTTP posting of scenario events to external endpoints.

    Single responsibility: Send events via HTTP to configured endpoints
    with proper authentication and error handling.

    Args:
        endpoint (str, optional): Override endpoint URL. If not provided, uses LANGWATCH_ENDPOINT env var.
        api_key (str, optional): Override API key. If not provided, uses LANGWATCH_API_KEY env var.

    Example:
        # Using environment variables (LANGWATCH_ENDPOINT, LANGWATCH_API_KEY)
        reporter = EventReporter()

        # Override specific values
        reporter = EventReporter(endpoint="https://langwatch.yourdomain.com")
        reporter = EventReporter(api_key="your-api-key")
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None):
        # Load settings from environment variables
        langwatch_settings = LangWatchSettings()

        # Allow constructor parameters to override settings
        self.endpoint = endpoint or langwatch_settings.endpoint
        self.api_key = api_key or langwatch_settings.api_key
        self.logger = logging.getLogger(__name__)
        self.event_alert_message_logger = EventAlertMessageLogger()

        # Show greeting message when reporter is initialized
        self.event_alert_message_logger.handle_greeting()

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        """
        Posts an event to the configured endpoint.

        Args:
            event: A ScenarioEvent containing the event data

        Returns:
            Dict containing response data, including setUrl if available
        """
        event_type = event.type_
        self.logger.info(f"[{event_type}] Publishing event ({event.scenario_run_id})")

        result: Dict[str, Any] = {}

        if not self.endpoint:
            self.logger.warning(
                "No LANGWATCH_ENDPOINT configured, skipping event posting"
            )
            return result

        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                response = await client.post(
                    f"{self.endpoint}/api/scenario-events",
                    json=event.to_dict(),
                    headers={
                        "Content-Type": "application/json",
                        "X-Auth-Token": self.api_key,
                    },
                )
                self.logger.info(
                    f"[{event_type}] POST response status: {response.status_code} ({event.scenario_run_id})"
                )

                if response.is_success:
                    data = response.json()
                    self.logger.info(
                        f"[{event_type}] POST response: {data} ({event.scenario_run_id})"
                    )

                    # Extract setUrl from response if available
                    if isinstance(data, dict) and "url" in data:
                        result["setUrl"] = data["url"]
                else:
                    error_text = response.text
                    self.logger.error(
                        f"[{event_type}] Event POST failed: status={response.status_code}, "
                        f"reason={response.reason_phrase}, error={error_text}, "
                        f"event={event}"
                    )
        except Exception as error:
            self.logger.error(
                f"[{event_type}] Event POST error: {error}, event={event}, endpoint={self.endpoint}"
            )

        return result
