import os
from typing import Set
from .._utils.ids import get_batch_run_id


class EventAlertMessageLogger:
    """
    Handles console output of alert messages for scenario events.

    Single responsibility: Display user-friendly messages about event reporting status
    and simulation watching instructions.
    """

    _shown_batch_ids: Set[str] = set()

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
        self, scenario_set_id: str, scenario_run_id: str, set_url: str
    ) -> None:
        """
        Shows a fancy message about how to watch the simulation.
        Called when a run started event is received with a session ID.
        """
        if self._is_greeting_disabled():
            return

        self._display_watch_message(set_url)

    def _is_greeting_disabled(self) -> bool:
        """Check if greeting messages are disabled via environment variable."""
        return bool(os.getenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO"))

    def _display_greeting(self, batch_run_id: str) -> None:
        """Display the greeting message with simulation reporting status."""
        separator = "─" * 60

        if not os.getenv("LANGWATCH_API_KEY"):
            print(f"\n{separator}")
            print("🚀  LangWatch Simulation Reporting")
            print(f"{separator}")
            print("➡️  API key not configured")
            print("   Simulations will only output final results")
            print("")
            print("💡 To visualize conversations in real time:")
            print("   • Set LANGWATCH_API_KEY environment variable")
            print("   • Or configure apiKey in scenario.config.js")
            print("")
            print(f"📦 Batch Run ID: {batch_run_id}")
            print(f"{separator}\n")
        else:
            endpoint = os.getenv("LANGWATCH_ENDPOINT", "https://app.langwatch.ai")
            api_key = os.getenv("LANGWATCH_API_KEY", "")

            print(f"\n{separator}")
            print("🚀  LangWatch Simulation Reporting")
            print(f"{separator}")
            print("✅ Simulation reporting enabled")
            print(f"   Endpoint: {endpoint}")
            print(f"   API Key: {'Configured' if api_key else 'Not configured'}")
            print("")
            print(f"📦 Batch Run ID: {batch_run_id}")
            print(f"{separator}\n")

    def _display_watch_message(self, set_url: str) -> None:
        """Display the watch message with URLs for viewing the simulation."""
        separator = "─" * 60
        batch_url = f"{set_url}/{get_batch_run_id()}"

        print(f"\n{separator}")
        print("👀 Watch Your Simulation Live")
        print(f"{separator}")
        print("🌐 Open in your browser:")
        print(f"   Scenario Set: {set_url}")
        print(f"   Batch Run: {batch_url}")
        print("")
        print(f"{separator}\n")
