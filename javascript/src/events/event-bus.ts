import { concatMap, EMPTY, catchError, Subject, Observable, Subscription } from "rxjs";
import { EventReporter } from "./event-reporter";
import { ScenarioEvent, ScenarioEventType } from "./schema";
import { Logger } from "../utils/logger";

const logger = new Logger("scenario.events.EventBus");

/**
 * Manages scenario event publishing, subscription, and processing pipeline.
 */
export class EventBus {
  private events$ = new Subject<ScenarioEvent>();
  private eventReporter: EventReporter;
  private processingPromise: Promise<void> | null = null;

  constructor(config: { endpoint: string; apiKey: string | undefined }) {
    this.eventReporter = new EventReporter(config);
  }

  /**
   * Publishes an event into the processing pipeline.
   */
  publish(event: ScenarioEvent): void {
    this.events$.next(event);
  }

  /**
   * Begins listening for and processing events.
   * Returns a promise that resolves when a RUN_FINISHED event is fully processed.
   */
  listen(): Promise<void> {
    if (this.processingPromise) {
      return this.processingPromise;
    }

    this.processingPromise = new Promise<void>((resolve, reject) => {
      this.events$
        .pipe(
          concatMap(async (event) => {
            await this.eventReporter.postEvent(event);
            return event;
          }),
          catchError((error) => {
            logger.error("Error in event stream:", error);
            return EMPTY;
          })
        )
        .subscribe({
          next: (event) => {
            if (event.type === ScenarioEventType.RUN_FINISHED) {
              resolve();
            }
          },
          error: (error) => {
            logger.error("Error in event stream:", error);
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
    this.events$.unsubscribe();

    if (this.processingPromise) {
      await this.processingPromise;
    }
  }

  /**
   * Subscribes to an event stream.
   * @param source$ - The event stream to subscribe to.
   */
  subscribeTo(source$: Observable<ScenarioEvent>): Subscription {
    return source$.subscribe(this.events$);
  }
}
