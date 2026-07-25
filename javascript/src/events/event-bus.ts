import {
  concatMap,
  EMPTY,
  catchError,
  Subject,
  Observable,
  Subscription,
} from "rxjs";
import { EventAlertMessageLogger } from "./event-alert-message-logger";
import { EventReporter } from "./event-reporter";
import { ScenarioEvent, ScenarioEventType } from "./schema";
import { Logger } from "../utils/logger";

/**
 * Manages scenario event publishing, subscription, and processing pipeline.
 */
export class EventBus {
  private static registry = new Set<EventBus>();
  private events$ = new Subject<ScenarioEvent>();
  private eventReporter: EventReporter;
  private eventAlertMessageLogger: EventAlertMessageLogger;
  private readonly config: {
    endpoint: string;
    apiKey: string | undefined;
    projectId?: string;
  };
  private processingPromise: Promise<void> | null = null;
  private logger = new Logger("scenario.events.EventBus");
  private static globalListeners: Array<(bus: EventBus) => void> = [];

  constructor(config: { endpoint: string; apiKey: string | undefined; projectId?: string }) {
    this.config = config;
    this.eventReporter = new EventReporter(config);
    this.eventAlertMessageLogger = new EventAlertMessageLogger();
    EventBus.registry.add(this);

    // Notify global listeners
    for (const listener of EventBus.globalListeners) {
      listener(this);
    }
  }

  static getAllBuses(): Set<EventBus> {
    return EventBus.registry;
  }

  static addGlobalListener(listener: (bus: EventBus) => void) {
    EventBus.globalListeners.push(listener);
  }

  /**
   * Publishes an event into the processing pipeline.
   */
  publish(event: ScenarioEvent): void {
    this.logger.debug(`[${event.type}] Publishing event`, {
      event,
    });
    this.events$.next(event);
  }

  /**
   * Begins listening for and processing events.
   * Returns a promise that resolves when a RUN_FINISHED event is fully processed.
   */
  listen(): Promise<void> {
    this.logger.debug("Listening for events");

    if (this.processingPromise) {
      return this.processingPromise;
    }

    this.processingPromise = new Promise<void>((resolve, reject) => {
      this.events$
        .pipe(
          // Post events, then settle the watch message before moving on.
          //
          // The watch message is awaited inside this stage rather than handed
          // to a `tap`: `tap` drops the promise, so a suite that finishes and
          // exits promptly could kill the process while the browser handoff
          // was still in flight — the run would be reported as opened with no
          // tab to show for it. It runs once per batch and off the scenario's
          // own critical path.
          concatMap(async (event: ScenarioEvent) => {
            this.logger.debug(`[${event.type}] Processing event`, { event });
            const result = await this.eventReporter.postEvent(event);

            if (event.type === ScenarioEventType.RUN_STARTED && result.setUrl) {
              // The browser-tab handoff talks to the same LangWatch instance
              // the events were just reported to.
              await this.eventAlertMessageLogger.handleWatchMessage({
                scenarioSetId: event.scenarioSetId,
                scenarioRunId: event.scenarioRunId,
                setUrl: result.setUrl,
                endpoint: this.config.endpoint,
                apiKey: this.config.apiKey,
                projectId: this.config.projectId,
              });
            }

            return event;
          }),

          catchError((error: unknown) => {
            this.logger.error("Error in event stream:", error);
            return EMPTY;
          })
        )
        .subscribe({
          next: (event: ScenarioEvent) => {
            this.logger.debug(`[${event.type}] Event processed`, { event });
            if (event.type === ScenarioEventType.RUN_FINISHED) {
              resolve();
            }
          },
          error: (error: unknown) => {
            this.logger.error("Error in event stream:", error);
            reject(error);
          },
        });
    });

    return this.processingPromise;
  }

  /**
   * Stops accepting new events and drains the processing queue.
   * Times out after the specified duration to prevent blocking indefinitely
   * when the events endpoint is slow or unavailable.
   */
  async drain(timeoutMs: number = 300_000): Promise<void> {
    this.logger.debug("Draining event stream");

    // Complete the stream, but don't unsubscribe the Subject itself!!!
    this.events$.complete();

    if (this.processingPromise) {
      await Promise.race([
        this.processingPromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
  }

  /**
   * Subscribes to an event stream.
   * @param source$ - The event stream to subscribe to.
   */
  subscribeTo(source$: Observable<ScenarioEvent>): Subscription {
    this.logger.debug("Subscribing to event stream");

    return source$.subscribe(this.events$);
  }

  /**
   * Expose the events$ observable for external subscription (read-only).
   */
  get eventsObservable(): Observable<ScenarioEvent> {
    return this.events$.asObservable();
  }
}
