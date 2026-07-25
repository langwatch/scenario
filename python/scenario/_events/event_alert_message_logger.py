import os
from typing import Optional, Set

from .._browser import BatchRunLocation, BrowserOutcome, show_batch_run
from ..config.scenario import ScenarioConfig
from .._utils.ids import get_batch_run_id


class EventAlertMessageLogger:
    """
    Handles console output of alert messages for scenario events.

    Single responsibility: Display user-friendly messages about event reporting status
    and simulation watching instructions.
    """

    _shown_batch_ids: Set[str] = set()
    _shown_watch_urls: Set[str] = set()

    def handle_greeting(self) -> None:
        """
        Shows a fancy greeting message about simulation reporting status.
        Only shows once per batch run to avoid spam.
        """
        if self._is_greeting_disabled():
            return

        batch_run_id = get_batch_run_id()

        if batch_run_id in EventAlertMessageLogger._shown_batch_ids:
            return

        EventAlertMessageLogger._shown_batch_ids.add(batch_run_id)
        self._display_greeting(batch_run_id)

    def handle_watch_message(
        self,
        set_url: str,
        scenario_set_id: Optional[str] = None,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> None:
        """
        Shows a fancy message about how to watch the simulation.
        Called when a run started event is received with a session ID.
        """
        if self._is_greeting_disabled():
            return

        if set_url in EventAlertMessageLogger._shown_watch_urls:
            return

        EventAlertMessageLogger._shown_watch_urls.add(set_url)
        self._display_watch_message(
            set_url,
            scenario_set_id=scenario_set_id,
            endpoint=endpoint,
            api_key=api_key,
            project_id=project_id,
        )

    def _is_greeting_disabled(self) -> bool:
        """Check if greeting messages are disabled via environment variable."""
        return bool(os.getenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO"))

    def _display_greeting(self, batch_run_id: str) -> None:
        """Display the greeting message with simulation reporting status."""
        separator = "─" * 60

        if not os.getenv("LANGWATCH_API_KEY"):
            print(f"\n{separator}")
            print("🎭  Running Scenario Tests")
            print(f"{separator}")
            print("➡️  LangWatch API key not configured")
            print("   Simulations will only output final results")
            print("")
            print("💡 To visualize conversations in real time:")
            print("   • Set LANGWATCH_API_KEY environment variable")
            print(f"{separator}\n")

    def _display_watch_message(
        self,
        set_url: str,
        scenario_set_id: Optional[str] = None,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> None:
        """Display the watch message with URLs for viewing the simulation."""
        separator = "─" * 60
        batch_run_id = get_batch_run_id()
        batch_url = f"{set_url}/{batch_run_id}"

        print(f"\n{separator}")
        print("🎭  Running Scenario Tests")
        print(f"{separator}")
        print(f"Follow it live: {batch_url}")

        config = ScenarioConfig.default_config or ScenarioConfig()
        outcome = show_batch_run(
            BatchRunLocation(
                batch_url=batch_url,
                batch_run_id=batch_run_id,
                scenario_set_id=scenario_set_id,
            ),
            headless=bool(config.headless),
            endpoint=endpoint,
            api_key=api_key,
            project_id=project_id,
        )

        if outcome is BrowserOutcome.HANDED_OFF:
            print("↻ Sent to the LangWatch tab you already have open")

        print(f"{separator}\n")
