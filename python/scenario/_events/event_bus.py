from rx.core.observable.observable import Observable
from typing import Optional, Any
from .events import ScenarioEvent
from .event_reporter import EventReporter

import asyncio
import queue
import threading
import logging

class ScenarioEventBus:
    """
    Subscribes to scenario event streams and handles HTTP posting using a dedicated worker thread.

    The EventBus acts as an observer of scenario events, automatically
    posting them to external APIs. It uses a queue-based threading model
    where events are processed by a dedicated worker thread.

    Key design principles:
    - Single worker thread handles all HTTP posting (simplifies concurrency)
    - Thread created lazily when first event arrives
    - Thread terminates when queue empty and stream completed
    - Non-daemon thread ensures all events posted before program exit

    Attributes:
        _event_reporter: EventReporter instance for HTTP posting of events
        _max_retries: Maximum number of retry attempts for failed event processing
        _event_queue: Thread-safe queue for passing events to worker thread
        _completed: Whether the event stream has completed
        _subscription: RxPY subscription to the event stream
        _worker_thread: Dedicated thread for processing events
    """

    def __init__(
        self, event_reporter: Optional[EventReporter] = None, max_retries: int = 3
    ):
        """
        Initialize the event bus with optional event reporter and retry configuration.

        Args:
            event_reporter: Optional EventReporter for HTTP posting of events.
                          If not provided, a default EventReporter will be created.
            max_retries: Maximum number of retry attempts for failed event processing.
                       Defaults to 3 attempts with exponential backoff.
        """
        self._event_reporter: EventReporter = event_reporter or EventReporter()
        self._max_retries = max_retries
        
        # Custom logger for this class
        self.logger = logging.getLogger(__name__)
        
        # Threading infrastructure
        self._event_queue: queue.Queue[ScenarioEvent] = queue.Queue()
        self._completed = False
        self._subscription: Optional[Any] = None
        self._worker_thread: Optional[threading.Thread] = None
        self._shutdown_event = threading.Event()  # Signal worker to shutdown

    def _get_or_create_worker(self) -> None:
        """Lazily create worker thread when first event arrives"""
        if self._worker_thread is None or not self._worker_thread.is_alive():
            self.logger.debug("Creating new worker thread")
            self._worker_thread = threading.Thread(
                target=self._worker_loop,
                daemon=False,
                name="ScenarioEventBus-Worker"
            )
            self._worker_thread.start()
            self.logger.debug("Worker thread started")

    def _worker_loop(self) -> None:
        """Main worker thread loop - processes events from queue until shutdown"""
        self.logger.debug("Worker thread loop started")
        while True:
            try:
                if self._shutdown_event.wait(timeout=0.1):
                    self.logger.debug("Worker thread received shutdown signal")
                    break
                
                try:
                    event = self._event_queue.get(timeout=0.1)
                    self.logger.debug(f"Worker picked up event: {event.type_} ({event.scenario_run_id})")
                    self._process_event_sync(event)
                    self._event_queue.task_done()
                except queue.Empty:
                    # Exit if stream completed and no more events
                    if self._completed:
                        self.logger.debug("Stream completed and no more events, worker thread exiting")
                        break
                    continue
                    
            except Exception as e:
                self.logger.error(f"Worker thread error: {e}")
        
        self.logger.debug("Worker thread loop ended")

    def _process_event_sync(self, event: ScenarioEvent) -> None:
        """
        Process event synchronously in worker thread with retry logic.
        """
        self.logger.debug(f"Processing HTTP post for {event.type_} ({event.scenario_run_id})")
        
        try:
            # Convert async to sync using asyncio.run - this blocks until HTTP completes
            success = asyncio.run(self._process_event_with_retry(event))
            if not success:
                self.logger.warning(f"Failed to process event {event.type_} after {self._max_retries} attempts")
            else:
                self.logger.debug(f"Successfully posted {event.type_} ({event.scenario_run_id})")
        except Exception as e:
            self.logger.error(f"Error processing event {event.type_}: {e}")

    async def _process_event_with_retry(self, event: ScenarioEvent, attempt: int = 1) -> bool:
        """
        Process a single event with retry logic (now runs in worker thread context).
        """
        try:
            if self._event_reporter:
                await self._event_reporter.post_event(event)
            return True
        except Exception as e:
            if attempt >= self._max_retries:
                return False
            print(f"Error processing event (attempt {attempt}/{self._max_retries}): {e}")
            await asyncio.sleep(0.1 * (2 ** (attempt - 1)))  # Exponential backoff
            return await self._process_event_with_retry(event, attempt + 1)

    def subscribe_to_events(self, event_stream: Observable) -> None:
        """
        Subscribe to any observable stream of scenario events.
        Events are queued for processing by the dedicated worker thread.
        """
        if self._subscription is not None:
            self.logger.debug("Already subscribed to event stream")
            return

        def handle_event(event: ScenarioEvent) -> None:
            self.logger.debug(f"Event received, queuing: {event.type_} ({event.scenario_run_id})")
            self._get_or_create_worker()
            self._event_queue.put(event)
            self.logger.debug(f"Event queued: {event.type_} ({event.scenario_run_id})")

        self.logger.info("Subscribing to event stream")
        self._subscription = event_stream.subscribe(
            handle_event,
            lambda e: self.logger.error(f"Error in event stream: {e}"),
            lambda: self._set_completed()
        )

    def _set_completed(self):
        """Helper to set completed state with logging"""
        self.logger.debug("Event stream completed")
        self._completed = True

    def drain(self) -> None:
        """
        Waits for all queued events to complete processing.
        
        This method blocks until all events in the queue have been processed.
        Since _process_event_sync() uses asyncio.run(), HTTP requests complete
        before task_done() is called, so join() ensures everything is finished.
        """
        self.logger.debug("Drain started - waiting for queue to empty")
        
        # Wait for all events to be processed - this is sufficient!
        self._event_queue.join()
        self.logger.debug("Event queue drained")
        
        # Signal worker to shutdown and wait for it
        self._shutdown_event.set()
        if self._worker_thread and self._worker_thread.is_alive():
            self.logger.debug("Waiting for worker thread to shutdown...")
            self._worker_thread.join(timeout=5.0)
            if self._worker_thread.is_alive():
                self.logger.warning("Worker thread did not shutdown within timeout")
            else:
                self.logger.debug("Worker thread shutdown complete")
        
        self.logger.info("Drain completed")

    def is_completed(self) -> bool:
        """
        Returns whether all events have been processed.
        """
        return self._completed and self._event_queue.empty()
