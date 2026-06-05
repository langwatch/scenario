import logging
import re
import httpx
from typing import ClassVar, Optional, Dict, Any
from .events import ScenarioEvent
from .event_alert_message_logger import EventAlertMessageLogger
from scenario.config import LangWatchSettings, ScenarioConfig


def _redacted_event_repr(event: Any) -> str:
    """
    Repr-style summary of an event with base64 audio payloads stripped.

    Failure logs include the full event for debuggability, but multimodal
    voice messages carry base64-encoded WAVs that dwarf everything else and
    flood the terminal. Replace audio payloads with ``<audio:N b64 chars
    elided>`` placeholders so the log stays readable while preserving message
    order and metadata. The redaction is applied to ``event.to_dict()`` when
    available, falling back to scrubbing the raw ``repr(event)`` string —
    that fallback matters because logging often runs in the exception path,
    where ``to_dict()`` itself may have failed.

    The dict-walker scrubs both real ``input_audio.data`` keys and any long
    base64 runs that appear inside string values, since upstream sometimes
    serialises content lists to ``repr()`` strings before they reach us.
    """
    try:
        payload = event.to_dict()
        return repr(_redact_audio(payload))
    except Exception:
        return _redact_b64_runs_in_text(repr(event))


def _redact_audio(node: Any) -> Any:
    if isinstance(node, dict):
        return {key: _redact_audio(value) for key, value in node.items()}
    if isinstance(node, list):
        return [_redact_audio(item) for item in node]
    if isinstance(node, str):
        return _redact_b64_runs_in_text(node)
    return node


_B64_RUN = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")


def _redact_b64_runs_in_text(text: str) -> str:
    return _B64_RUN.sub(
        lambda m: f"<audio:{len(m.group(0))} b64 chars elided>", text
    )


def _resolve_langwatch_client_api_key() -> str:
    """Read the langwatch SDK's class-level api_key, if the SDK is importable.

    The langwatch SDK accepts api_key both via env var and via
    `langwatch.setup(api_key=...)`. When the user goes the programmatic route
    (no env var), the value lives on `langwatch.client.Client._api_key`.
    Falling back to it here keeps scenario events working in the same
    process without forcing the user to set LANGWATCH_API_KEY twice.
    """
    try:
        from langwatch.client import Client
    except Exception:
        return ""
    return Client._api_key or ""


class EventReporter:
    """
    Handles HTTP posting of scenario events to external endpoints.

    Single responsibility: Send events via HTTP to configured endpoints
    with proper authentication and error handling.

    Args:
        endpoint (str, optional): Override endpoint URL. If not provided, uses LANGWATCH_ENDPOINT env var.
        api_key (str, optional): Override API key. Resolution order: explicit
            arg → LANGWATCH_API_KEY env var → langwatch.client.Client._api_key
            (set by langwatch.setup(api_key=...)).
        project_id (str, optional): Override LangWatch project ID. When set
            (alongside api_key), requests carry the X-Project-Id header. Falls
            back to LANGWATCH_PROJECT_ID env var.

    Example:
        # Using environment variables (LANGWATCH_ENDPOINT, LANGWATCH_API_KEY,
        # LANGWATCH_PROJECT_ID)
        reporter = EventReporter()

        # Or rely on langwatch.setup(api_key=...) called earlier in the process
        reporter = EventReporter()

        # Override specific values
        reporter = EventReporter(endpoint="https://langwatch.yourdomain.com")
        reporter = EventReporter(api_key="your-api-key", project_id="project_xxx")
    """

    # Process-wide flag: emit the "no api_key configured" warning at most once
    # per process. Without this, every dropped event spams the logs.
    _missing_api_key_warned: ClassVar[bool] = False

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        project_id: Optional[str] = None,
    ):
        # Load settings from environment variables
        langwatch_settings = LangWatchSettings()

        # Allow constructor parameters to override settings
        # Strip trailing slashes to avoid double-slash URLs (e.g. HttpUrl adds trailing /)
        raw_endpoint = endpoint or str(langwatch_settings.endpoint)
        self.endpoint = raw_endpoint.rstrip("/") if raw_endpoint else ""
        # Resolution order: explicit > env > langwatch SDK class state.
        self.api_key = (
            api_key
            or langwatch_settings.api_key
            or _resolve_langwatch_client_api_key()
        )
        self.project_id = project_id or langwatch_settings.project_id
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

        if not self.api_key:
            # Without an api_key the POST would be rejected with 401. Skip
            # silently — the EventAlertMessageLogger already prints a one-time
            # banner at startup explaining how to set LANGWATCH_API_KEY. Emit
            # a single WARNING per process so the reason for missing
            # visualization is searchable in logs.
            if not EventReporter._missing_api_key_warned:
                EventReporter._missing_api_key_warned = True
                self.logger.warning(
                    "No LangWatch api_key configured (set LANGWATCH_API_KEY "
                    "env var or call langwatch.setup(api_key=...) before "
                    "scenarios run); scenario events will not be reported."
                )
            return result

        try:
            url = f"{self.endpoint}/api/scenario-events"
            payload = event.to_dict()
            self.logger.debug(
                f"[{event_type}] POST {url} payload keys={list(payload.keys())} ({event.scenario_run_id})"
            )
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            }
            if self.project_id:
                headers["X-Project-Id"] = self.project_id
            async with httpx.AsyncClient(follow_redirects=True) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers=headers,
                    timeout=httpx.Timeout(30.0),
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
                        f"event={_redacted_event_repr(event)}"
                    )
        except Exception as error:
            self.logger.error(
                f"[{event_type}] Event POST error: {repr(error)}, event={_redacted_event_repr(event)}, endpoint={self.endpoint}"
            )

        return result
