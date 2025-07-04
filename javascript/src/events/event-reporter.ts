import { EventAlertMessageLogger } from "./event-alert-message-logger";
import { ScenarioEventType, type ScenarioEvent } from "./schema";
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
  private readonly isEnabled: boolean;

  constructor(config: { endpoint: string; apiKey: string | undefined }) {
    this.apiKey = config.apiKey ?? "";
    this.eventsEndpoint = new URL("/api/scenario-events", config.endpoint);
    this.eventAlertMessageLogger = new EventAlertMessageLogger();
    this.eventAlertMessageLogger.handleGreeting();
    this.isEnabled =
      this.apiKey.length > 0 && this.eventsEndpoint.href.length > 0;
  }

  /**
   * Posts an event to the configured endpoint.
   * Logs success/failure but doesn't throw - event posting shouldn't break scenario execution.
   */
  async postEvent(event: ScenarioEvent): Promise<{ setUrl?: string }> {
    /**
     * Early exit to prevent events from being posted if the endpoint is not configured.
     */
    if (!this.isEnabled) return {};

    const result: { setUrl?: string } = {};
    this.logger.debug(`[${event.type}] Posting event`, { event });
    const processedEvent = this.processEventForApi(event);

    try {
      const response = await fetch(this.eventsEndpoint.href, {
        method: "POST",
        body: JSON.stringify(processedEvent),
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": this.apiKey,
        },
      });

      this.logger.debug(
        `[${event.type}] Event POST response status: ${response.status}`
      );

      if (response.ok) {
        const data = (await response.json()) as { url: string };
        this.logger.debug(`[${event.type}] Event POST response:`, data);
        result.setUrl = data.url;
      } else {
        const errorText = await response.text();
        this.logger.error(`[${event.type}] Event POST failed:`, {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          event: JSON.stringify(processedEvent),
        });
      }
    } catch (error) {
      this.logger.error(`[${event.type}] Event POST error:`, {
        error,
        event: JSON.stringify(processedEvent),
        endpoint: this.eventsEndpoint.href,
      });
    }

    return result;
  }

  /**
   * Processes event data to ensure API compatibility.
   * Converts message content objects to strings when needed.
   */
  private processEventForApi(event: ScenarioEvent): ScenarioEvent {
    if (event.type === ScenarioEventType.MESSAGE_SNAPSHOT) {
      return {
        ...event,
        messages: event.messages.map((message) => ({
          ...message,
          content:
            typeof message.content !== "string"
              ? JSON.stringify(message.content)
              : message.content,
        })),
      };
    }
    return event;
  }
}
