import {
  concatMap,
  catchError,
  defer,
  map,
  of,
  retry,
  Subject,
  Observable,
  Subscription,
  timer,
} from "rxjs";
import { EventAlertMessageLogger } from "./event-alert-message-logger";
import { EventReporter } from "./event-reporter";
import { ScenarioEvent, ScenarioEventType } from "./schema";
import { Logger } from "../utils/logger";

/**
 * A 4xx other than request timeout (408) and rate limit (429) is a permanent
 * client error: retrying the identical request can never succeed.
 */
function isPermanentClientError(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * Manages scenario event publishing, subscription, and processing pipeline.
 */
export class EventBus {
  /** Total delivery attempts per event, including the first one. */
  private static readonly maxRetries = 3;
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
          // Retry and error handling are scoped per event: a failed event is
          // retried with backoff and, if it keeps failing, dropped — it never
          // terminates the stream and never takes the events behind it down.
          concatMap((event: ScenarioEvent) =>
            defer(() => this.processEvent(event)).pipe(
              retry({
                count: EventBus.maxRetries - 1,
                delay: (error: unknown, retryCount: number) => {
                  const status = (error as { status?: number }).status;
                  if (isPermanentClientError(status)) {
                    // Retrying a permanent 4xx (other than 408/429) can never
                    // succeed; fail straight through to the drop below.
                    throw error;
                  }
                  this.logger.warn(
                    `[${event.type}] Event delivery failed (attempt ${retryCount}/${EventBus.maxRetries}), retrying`,
                    error
                  );
                  return timer(100 * 2 ** (retryCount - 1));
                },
              }),
              catchError((error: unknown) => {
                this.logger.error(
                  `[${event.type}] Dropping event after failed delivery`,
                  error
                );
                return of(void 0);
              }),
              map(() => event)
            )
          )
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
          // The stream completing means every event was processed or dropped;
          // drain() must resolve here too, not only on RUN_FINISHED, or a
          // dropped RUN_FINISHED would leave drain() waiting on its timeout.
          complete: () => {
            resolve();
          },
        });
    });

    return this.processingPromise;
  }

  /**
   * Posts one event, then settles the watch message before moving on.
   *
   * The watch message is awaited here rather than handed to a `tap`: `tap`
   * drops the promise, so a suite that finishes and exits promptly could kill
   * the process while the browser handoff was still in flight — the run would
   * be reported as opened with no tab to show for it. It runs once per batch
   * and off the scenario's own critical path.
   */
  private async processEvent(event: ScenarioEvent): Promise<void> {
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.processingPromise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    // A drained bus is finished: drop it from the registry so completed runs
    // do not accumulate for the process lifetime.
    EventBus.registry.delete(this);
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
