import os
import webbrowser
from typing import Set

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

    def handle_watch_message(self, set_url: str) -> None:
        """
        Shows a fancy message about how to watch the simulation.
        Called when a run started event is received with a session ID.
        """
        if self._is_greeting_disabled():
            return

        if set_url in EventAlertMessageLogger._shown_watch_urls:
            return

        EventAlertMessageLogger._shown_watch_urls.add(set_url)
        self._display_watch_message(set_url)

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

    def _display_watch_message(self, set_url: str) -> None:
        """Display the watch message with URLs for viewing the simulation."""
        separator = "─" * 60
        batch_url = f"{set_url}/{get_batch_run_id()}"

        print(f"\n{separator}")
        print("🎭  Running Scenario Tests")
        print(f"{separator}")
        print(f"Follow it live: {batch_url}")
        print(f"{separator}\n")

        config = ScenarioConfig.default_config
        if config and not config.headless:
            # Open the URL in the default browser (cross-platform)
            try:
                webbrowser.open(batch_url)
            except Exception:
                pass
