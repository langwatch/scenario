import type { ScenarioEvent } from "./schema";
import { env } from "../config";
import { EventAlertMessageLogger } from "./event-alert-message-logger";
import { Logger } from "../utils/logger";

/**
 * Handles HTTP posting of scenario events to external endpoints.
 *
 * Single responsibility: Send events via HTTP to configured endpoints
 * with proper authentication and error handling.
 */
export class EventReporter {
  private readonly apiKey: string;
  private readonly eventsEndpoint: URL;
  private readonly eventAlertMessageLogger: EventAlertMessageLogger;
  private readonly logger = new Logger("scenario.events.EventReporter");

  constructor(config: { endpoint: string; apiKey: string | undefined }) {
    this.apiKey = config.apiKey ?? "";
    this.eventsEndpoint = new URL("/api/scenario-events", config.endpoint);
    this.eventAlertMessageLogger = new EventAlertMessageLogger();
    this.eventAlertMessageLogger.handleGreeting();
  }

  /**
   * Posts an event to the configured endpoint.
   * Logs success/failure but doesn't throw - event posting shouldn't break scenario execution.
   */
  async postEvent(event: ScenarioEvent): Promise<void> {
    this.logger.debug(`[${event.type}] Posting event`, {
      event,
    });

    if (!env.LANGWATCH_ENDPOINT) {
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
        event: event,
        endpoint: this.eventsEndpoint.href,
      });
      // Don't throw - event posting shouldn't break scenario execution
    }
  }
}
