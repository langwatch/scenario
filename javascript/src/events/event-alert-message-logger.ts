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
      console.log("🚀  LangWatch Simulation Reporting");
      console.log(`${separator}`);
      console.log("➡️  API key not configured");
      console.log("   Simulations will only output final results");
      console.log("");
      console.log("💡 To visualize conversations in real time:");
      console.log("   • Set LANGWATCH_API_KEY environment variable");
      console.log("   • Or configure apiKey in scenario.config.js");
      console.log("");
      console.log(`📦 Batch Run ID: ${getBatchRunId()}`);
      console.log("");
      console.log("🔇 To disable these messages:");
      console.log("   • Set SCENARIO_DISABLE_SIMULATION_REPORT_INFO=true");
      console.log(`${separator}\n`);
    } else {
      console.log(`\n${separator}`);
      console.log("🚀  LangWatch Simulation Reporting");
      console.log(`${separator}`);
      console.log("✅ Simulation reporting enabled");
      console.log(`   Endpoint: ${env.LANGWATCH_ENDPOINT}`);
      console.log(
        `   API Key: ${
          env.LANGWATCH_API_KEY.length > 0 ? "Configured" : "Not configured"
        }`
      );
      console.log("");
      console.log(`📦 Batch Run ID: ${getBatchRunId()}`);
      console.log("");
      console.log("🔇 To disable these messages:");
      console.log("   • Set SCENARIO_DISABLE_SIMULATION_REPORT_INFO=true");
      console.log(`${separator}\n`);
    }
  }

  private displayWatchMessage(params: { setUrl: string }): void {
    const separator = "─".repeat(60);
    const setUrl = params.setUrl;
    const batchUrl = `${setUrl}/${getBatchRunId()}`;

    console.log(`\n${separator}`);
    console.log("👀 Watch Your Simulation Live");
    console.log(`${separator}`);
    console.log("🌐 Open in your browser:");
    console.log(`   Scenario Set: ${setUrl}`);
    console.log(`   Batch Run: ${batchUrl}`);
    console.log("");
    console.log(`${separator}\n`);
  }
}
