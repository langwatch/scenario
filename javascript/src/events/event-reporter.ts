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
  private readonly projectId: string | undefined;
  private readonly eventsEndpoint: URL;
  private readonly eventAlertMessageLogger: EventAlertMessageLogger;
  private readonly logger = new Logger("scenario.events.EventReporter");
  private readonly isEnabled: boolean;

  constructor(config: { endpoint: string; apiKey: string | undefined; projectId?: string }) {
    this.apiKey = config.apiKey ?? "";
    this.projectId = config.projectId;
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
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Auth-Token": this.apiKey,
      };
      if (this.projectId) {
        headers["X-Project-Id"] = this.projectId;
      }
      const response = await fetch(this.eventsEndpoint.href, {
        method: "POST",
        body: JSON.stringify(processedEvent),
        headers,
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
          endpoint: this.eventsEndpoint.href,
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
   *
   * Message content normalisation:
   *   - string  → passed through unchanged.
   *   - array   → passed through unchanged (NOT JSON.stringify-ed). Array
   *     content carries OpenAI Realtime `input_audio` parts produced by
   *     `convertModelMessagesToAguiMessages` (commit 180bab4). The langwatch
   *     ingest content-extractor walks ARRAY content only and externalises
   *     inline audio to stored-objects; pre-stringifying re-buries those bytes
   *     as a plain string the extractor skips, so the base64 persists inline
   *     (the 90 MB getSuiteRunData / "audio not sending" bug). The ingest
   *     schema accepts arrays via
   *     `chatMessageSchema.content: union(string, array(chatRichContent))`, so
   *     sending an array on the wire is schema-valid.
   *   - other   → JSON.stringify-ed defensively (kept from PR #42's original
   *     coercion for AG-UI's string-typed content).
   *
   *   AG-UI's `MessagesSnapshotEventSchema` types message `content` as
   *   `string`, but post-180bab4 it carries arrays at runtime — the same
   *   mismatch 180bab4 bridges with a cast at the conversion boundary. We cast
   *   back here.
   */
  private processEventForApi(event: ScenarioEvent): ScenarioEvent {
    if (event.type === ScenarioEventType.MESSAGE_SNAPSHOT) {
      return {
        ...event,
        messages: event.messages.map((message) => ({
          ...message,
          // AG-UI types `content` as `string`; the normalised value may be an
          // array (runtime audio content) or `undefined` (optional assistant
          // content). Cast at the boundary like 180bab4's converter — the
          // ingest schema accepts the union via `chatMessageSchema.content`.
          content: normalizeMessageContent(message.content) as unknown as string,
        })),
      };
    }
    return event;
  }
}

/**
 * Coerce a message's `content` into a wire-safe shape for /api/scenario-events.
 *
 * Strings and arrays pass through unchanged (arrays must survive intact so the
 * ingest extractor can walk them and externalise inline `input_audio` — see
 * `processEventForApi`). Any other runtime shape is JSON.stringify-ed.
 *
 * AG-UI types `content` as `string`; arrays only appear at runtime
 * (post-180bab4), so the return is cast back to `string` at this boundary. The
 * runtime payload is valid per the ingest `chatMessageSchema.content` union of
 * string and array.
 */
function normalizeMessageContent(
  content: string | undefined
): string | undefined {
  const runtimeContent = content as unknown;

  if (
    runtimeContent == null ||
    typeof runtimeContent === "string" ||
    Array.isArray(runtimeContent)
  ) {
    return runtimeContent as string | undefined;
  }

  return JSON.stringify(runtimeContent);
}
