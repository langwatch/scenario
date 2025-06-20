import type { ScenarioEvent } from "./schema";
import { Logger } from "../utils/logger";

/**
 * Handles HTTP posting of scenario events to external endpoints.
 *
 * Single responsibility: Send events via HTTP to configured endpoints
 * with proper authentication and error handling.
 */
export class EventReporter {
  private readonly eventsEndpoint: URL;
  private readonly apiKey: string;
  private readonly logger = new Logger("scenario.events.EventReporter");

  constructor(config: { endpoint: string; apiKey: string | undefined }) {
    this.eventsEndpoint = new URL("/api/scenario-events", config.endpoint);
    this.apiKey = config.apiKey ?? "";

    if (!process.env.SCENARIO_DISABLE_SIMULATION_REPORT_INFO) {
      console.log("=== Scenario Simulation Reporting ===");
      if (!this.apiKey) {
        console.warn("LangWatch API key not configured, simulations will be local");
        console.warn(`To enable simulation reporting in the LangWatch dashboard, configure your LangWatch API key (via LANGWATCH_API_KEY, or scenario.config.js)`);
      } else {
        console.log("Simulation reporting is enabled");
        console.log(`Endpoint: ${config.endpoint} -> ${this.eventsEndpoint.href}`);
        console.log(`API Key: ${!this.apiKey ? "not configured" : "configured"}`);
      }
      console.log("=== Scenario Simulation Reporting ===");
    }
  }

  /**
   * Posts an event to the configured endpoint.
   * Logs success/failure but doesn't throw - event posting shouldn't break scenario execution.
   */
  async postEvent(event: ScenarioEvent): Promise<void> {
    this.logger.debug(`[${event.type}] Posting event`, {
      event,
    });

    if (!this.eventsEndpoint) {
      this.logger.warn(
        "No LANGWATCH_ENDPOINT configured, skipping event posting"
      );
      return;
    }

    try {
      const response = await fetch(this.eventsEndpoint.href, {
        method: "POST",
        body: JSON.stringify(event),
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": this.apiKey,
        },
      });

      this.logger.debug(
        `[${event.type}] Event POST response status: ${response.status}`
      );

      if (response.ok) {
        const data = await response.json();
        this.logger.debug(`[${event.type}] Event POST response:`, data);
      } else {
        const errorText = await response.text();
        this.logger.error(`[${event.type}] Event POST failed:`, {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          event: event,
        });
        // Don't throw - event posting shouldn't break scenario execution
      }
    } catch (error) {
      this.logger.error(`[${event.type}] Event POST error:`, {
        error,
        event,
        endpoint: this.eventsEndpoint,
      });
      // Don't throw - event posting shouldn't break scenario execution
    }
  }
}
