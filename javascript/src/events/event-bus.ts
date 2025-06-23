import { concatMap, EMPTY, catchError, Subject, Observable, Subscription } from "rxjs";
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
  private processingPromise: Promise<void> | null = null;
  private logger = new Logger("scenario.events.EventBus");
  private static globalListeners: Array<(bus: EventBus) => void> = [];

  constructor(config: { endpoint: string; apiKey: string | undefined }) {
    this.eventReporter = new EventReporter(config);
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
          concatMap(async (event: ScenarioEvent) => {
            this.logger.debug(`[${event.type}] Processing event`, {
              event,
            });

            await this.eventReporter.postEvent(event);
            return event;
          }),
          catchError((error: unknown) => {
            this.logger.error("Error in event stream:", error);

            return EMPTY;
          })
        )
        .subscribe({
          next: (event: ScenarioEvent) => {
            this.logger.debug(`[${event.type}] Event processed`, {
              event,
            });

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
   */
  async drain(): Promise<void> {
    this.logger.debug("Draining event stream");

    // Complete the stream, but don't unsubscribe the Subject itself!!!
    this.events$.complete();

    if (this.processingPromise) {
      await this.processingPromise;
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
