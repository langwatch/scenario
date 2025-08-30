import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import open from "open";
import { getEnv, getProjectConfig } from "../config";
import { getBatchRunId } from "../utils/ids";

/**
 * Handles console output of alert messages for scenario events.
 *
 * Single responsibility: Display user-friendly messages about event reporting status
 * and simulation watching instructions.
 */
export class EventAlertMessageLogger {
  /**
   * Creates a coordination file to prevent duplicate messages across processes.
   * Returns true if this process should show the message (first one to create the file).
   */
  private createCoordinationFile(
    type: "greeting" | `watch-${string}`
  ): boolean {
    try {
      const batchId = getBatchRunId();
      const tmpDir = os.tmpdir();
      const fileName = `scenario-${type}-${batchId}`;
      const filePath = path.join(tmpDir, fileName);

      // Try to create the file exclusively (fails if it already exists)
      fs.writeFileSync(filePath, process.pid.toString(), { flag: "wx" });
      return true;
    } catch {
      // File already exists or filesystem is read-only
      return false;
    }
  }

  /**
   * Shows a fancy greeting message about simulation reporting status.
   * Only shows once per batch run to avoid spam.
   */
  handleGreeting(): void {
    if (this.isGreetingDisabled()) {
      return;
    }

    if (!this.createCoordinationFile("greeting")) {
      return;
    }

    this.displayGreeting();
  }

  /**
   * Shows a fancy message about how to watch the simulation.
   * Called when a run started event is received with a session ID.
   */
  async handleWatchMessage(params: {
    scenarioSetId: string;
    scenarioRunId: string;
    setUrl: string;
  }): Promise<void> {
    if (this.isGreetingDisabled()) {
      return;
    }

    if (!this.createCoordinationFile(`watch-${params.scenarioSetId}`)) {
      return;
    }

    await this.displayWatchMessage(params);
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

  private async displayWatchMessage(params: { setUrl: string }): Promise<void> {
    const separator = "─".repeat(60);
    const setUrl = params.setUrl;
    const batchUrl = `${setUrl}/${getBatchRunId()}`;

    console.log(`\n${separator}`);
    console.log("🎭  Running Scenario Tests");
    console.log(`${separator}`);
    console.log(`Follow it live: ${batchUrl}`);
    console.log(`${separator}\n`);

    const projectConfig = await getProjectConfig();

    if (!projectConfig?.headless) {
      try {
        open(batchUrl);
        // eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars
      } catch (_) {
        // Do nothing
      }
    }
  }
}
