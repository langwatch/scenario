import open from "open";
import { getEnv } from "../config";
import { getBatchRunId } from "../utils/ids";

/**
 * Handles console output of alert messages for scenario events.
 *
 * Single responsibility: Display user-friendly messages about event reporting status
 * and simulation watching instructions.
 */
export class EventAlertMessageLogger {
  private static shownBatchIds = new Set<string>();

  /**
   * Shows a fancy greeting message about simulation reporting status.
   * Only shows once per batch run to avoid spam.
   */
  handleGreeting(): void {
    if (this.isGreetingDisabled()) {
      return;
    }

    if (EventAlertMessageLogger.shownBatchIds.has(getBatchRunId())) {
      return;
    }

    EventAlertMessageLogger.shownBatchIds.add(getBatchRunId());
    this.displayGreeting();
  }

  /**
   * Shows a fancy message about how to watch the simulation.
   * Called when a run started event is received with a session ID.
   */
  handleWatchMessage(params: {
    scenarioSetId: string;
    scenarioRunId: string;
    setUrl: string;
  }): void {
    if (this.isGreetingDisabled()) {
      return;
    }

    this.displayWatchMessage(params);
  }

  private isGreetingDisabled(): boolean {
    return getEnv().SCENARIO_DISABLE_SIMULATION_REPORT_INFO === true;
  }

  private displayGreeting(): void {
    const separator = "─".repeat(60);
    const env = getEnv();

    if (!env.LANGWATCH_API_KEY) {
      console.log(`\n${separator}`);
      console.log("🎭  Running Scenario Tests");
      console.log(`${separator}`);
      console.log("➡️  LangWatch API key not configured");
      console.log("   Simulations will only output final results");
      console.log("");
      console.log("💡 To visualize conversations in real time:");
      console.log("   • Set LANGWATCH_API_KEY environment variable");
      console.log("   • Or configure apiKey in scenario.config.js");
      console.log("");
      console.log(`${separator}\n`);
    }
  }

  private displayWatchMessage(params: { setUrl: string }): void {
    const separator = "─".repeat(60);
    const setUrl = params.setUrl;
    const batchUrl = `${setUrl}/${getBatchRunId()}`;

    console.log(`\n${separator}`);
    console.log("🎭  Running Scenario Tests");
    console.log(`${separator}`);
    console.log(`Follow it live: ${batchUrl}`);
    console.log(`${separator}\n`);

    try {
      open(batchUrl);
      // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
    } catch (_) {
      // Do nothing
    }
  }
}
