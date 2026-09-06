from rx.core.observable.observable import Observable
from typing import Optional, Any, Dict
from .events import ScenarioEvent
from .event_reporter import EventReporter
from .event_alert_message_logger import EventAlertMessageLogger
from ..config.scenario import ScenarioConfig

import asyncio
import inspect
import queue
import threading
import time
import logging

import httpx


def _is_permanent_client_error(error: BaseException) -> bool:
    """
    A 4xx other than request timeout (408) and rate limit (429) is a permanent
    client error: retrying the identical request can never succeed.
    """
    if not isinstance(error, httpx.HTTPStatusError):
        return False
    status = error.response.status_code
    return 400 <= status < 500 and status not in (408, 429)


# How long drain waits for a worker that is ending to release the queue.
WORKER_HANDOVER_TIMEOUT_SECONDS = 5.0

# How long drain waits for every queued event to be processed.
QUEUE_DRAIN_TIMEOUT_SECONDS = 30.0


def _accepts_http_client(post_event: Any) -> bool:
    """True when a reporter's post_event takes an `http_client` argument."""
    try:
        parameters = inspect.signature(post_event).parameters
    except (TypeError, ValueError):
        return False
    if "http_client" in parameters:
        return True
    return any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )


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
        _event_alert_message_logger: EventAlertMessageLogger for user-friendly console output
        _max_retries: Maximum number of retry attempts for failed event processing
        _event_queue: Thread-safe queue for passing events to worker thread
        _completed: Whether the event stream has completed
        _subscription: RxPY subscription to the event stream
        _worker_thread: Dedicated thread for processing events
    """

    def __init__(
        self,
        event_reporter: Optional[EventReporter] = None,
        max_retries: int = 3,
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
        self._event_alert_message_logger = EventAlertMessageLogger()
        self._max_retries = max_retries
        # A custom reporter may implement post_event(self, event) only. Such a
        # reporter manages its own transport, so the worker keeps no client
        # for it and calls it with the event alone.
        self._reporter_takes_http_client = _accepts_http_client(
            self._event_reporter.post_event
        )

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
            # Each worker owns the event it watches. Drain signals the current
            # one and then installs a fresh event for the next worker, so a
            # worker that is still ending can never miss the signal it was
            # given, and can never be un-signalled by a replacement.
            shutdown_event = threading.Event()
            self._shutdown_event = shutdown_event
            self._worker_thread = threading.Thread(
                target=self._worker_loop,
                args=(shutdown_event,),
                daemon=False,
                name="ScenarioEventBus-Worker",
            )
            self._worker_thread.start()
            self.logger.debug("Worker thread started")

    def _worker_loop(self, shutdown_event: threading.Event) -> None:
        """Main worker thread loop - processes events from queue until shutdown"""
        self.logger.debug("Worker thread loop started")
        # One event loop and one HTTP client for the worker's lifetime, so
        # retries and consecutive events reuse connections instead of paying a
        # full client setup per event. The client belongs to this worker and
        # is passed to each post: a client bound to this loop must never be
        # reachable from another worker, which could still be using it while
        # this one closes it.
        loop = asyncio.new_event_loop()
        owned_client: Optional[httpx.AsyncClient] = None
        if self._reporter_takes_http_client:
            owned_client = httpx.AsyncClient(follow_redirects=True)
        try:
            while True:
                try:
                    if shutdown_event.wait(timeout=0.1):
                        # Shutdown means the caller stopped waiting, not that
                        # the queue may be abandoned: drain's deadline can pass
                        # while an earlier event is still retrying, with the
                        # run finished event queued behind it. Deliver what is
                        # left before exiting, or that event would sit on the
                        # queue with no worker to ever take it.
                        self.logger.debug("Worker thread received shutdown signal")
                        self._sweep_remaining_events(loop, owned_client)
                        break

                    try:
                        event = self._event_queue.get(timeout=0.1)
                        self.logger.debug(
                            f"Worker picked up event: {event.type_} ({event.scenario_run_id})"
                        )
                        self._process_event_sync(event, loop, owned_client)
                        self._event_queue.task_done()
                    except queue.Empty:
                        # Exit if stream completed and no more events, but
                        # sweep first: an event enqueued between the timeout
                        # and the completion check would otherwise be stranded
                        # with task_done() never called, deadlocking drain().
                        if self._completed:
                            self._sweep_remaining_events(loop, owned_client)
                            self.logger.debug(
                                "Stream completed and no more events, worker thread exiting"
                            )
                            break
                        continue

                except Exception as e:
                    self.logger.error(f"Worker thread error: {e}")
        finally:
            if owned_client is not None:
                try:
                    loop.run_until_complete(owned_client.aclose())
                except Exception as e:
                    self.logger.debug(f"Error closing shared HTTP client: {e}")
            loop.close()

        self.logger.debug("Worker thread loop ended")

    def _sweep_remaining_events(
        self,
        loop: asyncio.AbstractEventLoop,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        """Process any events that landed on the queue as the worker was exiting."""
        while True:
            try:
                event = self._event_queue.get_nowait()
            except queue.Empty:
                return
            self.logger.debug(
                f"Worker exit sweep picked up event: {event.type_} ({event.scenario_run_id})"
            )
            self._process_event_sync(event, loop, http_client)
            self._event_queue.task_done()

    def _process_event_sync(
        self,
        event: ScenarioEvent,
        loop: asyncio.AbstractEventLoop,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        """
        Process event synchronously in worker thread with retry logic.
        """
        self.logger.debug(
            f"Processing HTTP post for {event.type_} ({event.scenario_run_id})"
        )

        try:
            result = self._post_event_with_retry(event, loop, http_client)
            self._handle_event_result(event, result)
        except Exception as e:
            self.logger.error(f"Error processing event {event.type_}: {e}")

    def _post_event_with_retry(
        self,
        event: ScenarioEvent,
        loop: asyncio.AbstractEventLoop,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Post event with retry logic, converting async to sync on the worker's loop.
        """
        return loop.run_until_complete(
            self._process_event_with_retry(event, http_client=http_client)
        )

    def _handle_event_result(
        self, event: ScenarioEvent, result: Optional[Dict[str, Any]]
    ) -> None:
        """
        Handle the result of event processing, including logging and watch messages.
        """
        if result is None:
            self.logger.warning(
                f"Failed to process event {event.type_} after {self._max_retries} attempts"
            )
            return

        self.logger.debug(
            f"Successfully posted {event.type_} ({event.scenario_run_id})"
        )

        # Handle watch message for run started events
        if event.type_ == "SCENARIO_RUN_STARTED" and result.get("setUrl"):
            self._handle_watch_message(event, result)

    def _handle_watch_message(
        self, event: ScenarioEvent, result: Dict[str, Any]
    ) -> None:
        """
        Handle watch message for scenario run started events.
        """
        # The reporter already resolved the endpoint and credentials, and the
        # browser-tab handoff talks to the same LangWatch instance.
        self._event_alert_message_logger.handle_watch_message(
            set_url=str(result["setUrl"]),
            scenario_set_id=self._extract_scenario_set_id(event),
            endpoint=self._event_reporter.endpoint,
            api_key=self._event_reporter.api_key,
            project_id=self._event_reporter.project_id,
        )

    def _extract_scenario_set_id(self, event: ScenarioEvent) -> str:
        """
        Extract scenario set ID from event, handling Unset types from generated models.
        """
        scenario_set_id = getattr(event, "scenario_set_id", "default")

        # Handle Unset type from generated models
        if hasattr(scenario_set_id, "__class__") and "Unset" in str(
            scenario_set_id.__class__
        ):
            return "default"

        return str(scenario_set_id)

    async def _process_event_with_retry(
        self,
        event: ScenarioEvent,
        attempt: int = 1,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Process a single event with retry logic (now runs in worker thread context).
        """
        try:
            if self._event_reporter:
                if http_client is not None:
                    return await self._event_reporter.post_event(
                        event, http_client=http_client
                    )
                return await self._event_reporter.post_event(event)
            return {}
        except Exception as e:
            if attempt >= self._max_retries or _is_permanent_client_error(e):
                return None
            self.logger.warning(
                f"Error processing event (attempt {attempt}/{self._max_retries}): {e}"
            )
            await asyncio.sleep(0.1 * (2 ** (attempt - 1)))  # Exponential backoff
            return await self._process_event_with_retry(
                event, attempt + 1, http_client=http_client
            )

    def subscribe_to_events(self, event_stream: Observable) -> None:
        """
        Subscribe to any observable stream of scenario events.
        Events are queued for processing by the dedicated worker thread.
        """
        if self._subscription is not None:
            self.logger.debug("Already subscribed to event stream")
            return

        def handle_event(event: ScenarioEvent) -> None:
            self.logger.debug(
                f"Event received, queuing: {event.type_} ({event.scenario_run_id})"
            )
            self._get_or_create_worker()
            self._event_queue.put(event)
            self.logger.debug(f"Event queued: {event.type_} ({event.scenario_run_id})")

        self.logger.info("Subscribing to event stream")
        self._subscription = event_stream.subscribe(
            handle_event,
            lambda e: self.logger.error(f"Error in event stream: {e}"),
            lambda: self._set_completed(),
        )

    def _set_completed(self):
        """Helper to set completed state with logging"""
        self.logger.debug("Event stream completed")
        self._completed = True

    def _join_queue(self, timeout: float) -> bool:
        """
        `queue.join()` with a deadline.

        Returns True when every task finished, False when the deadline passed
        with work still outstanding.
        """
        deadline = time.monotonic() + timeout
        with self._event_queue.all_tasks_done:
            while self._event_queue.unfinished_tasks:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._event_queue.all_tasks_done.wait(remaining)
        return True

    def drain(self) -> None:
        """
        Waits for all queued events to complete processing.

        This method blocks until all events in the queue have been processed:
        the worker completes each HTTP request before calling task_done(), so
        join() ensures everything is finished. After draining, the bus is
        reset so it can subscribe to a new stream and be reused.
        """
        self.logger.debug("Drain started - waiting for queue to empty")

        # If the worker exited in the completion race while an event was being
        # enqueued, the join below would block forever, so revive it first. A
        # worker that has left its loop but is still inside its finally block
        # still reports is_alive(), and would never take the event: wait for
        # it to end before deciding, then start a replacement.
        if not self._event_queue.empty():
            outgoing = self._worker_thread
            if outgoing is not None and outgoing.is_alive():
                outgoing.join(timeout=WORKER_HANDOVER_TIMEOUT_SECONDS)
            if not self._event_queue.empty():
                if outgoing is not None and not outgoing.is_alive():
                    self._worker_thread = None
                self._get_or_create_worker()

        # Wait for all events to be processed. The wait is bounded: a worker
        # that died with an event in flight would never call task_done(), and
        # a scenario run must not hang on its own telemetry. A worker that is
        # merely slow keeps delivering the queue after the caller is released,
        # and the process waits for it at exit because the thread is not a
        # daemon.
        if not self._join_queue(timeout=QUEUE_DRAIN_TIMEOUT_SECONDS):
            self.logger.warning(
                "Event queue did not drain within "
                f"{QUEUE_DRAIN_TIMEOUT_SECONDS}s; the worker keeps delivering "
                "the events left in the background"
            )
        self.logger.debug("Event queue drained")

        # Signal worker to shutdown and wait for it
        self._shutdown_event.set()
        worker_ended = True
        if self._worker_thread and self._worker_thread.is_alive():
            self.logger.debug("Waiting for worker thread to shutdown...")
            self._worker_thread.join(timeout=WORKER_HANDOVER_TIMEOUT_SECONDS)
            if self._worker_thread.is_alive():
                worker_ended = False
                self.logger.warning("Worker thread did not shutdown within timeout")
            else:
                self.logger.debug("Worker thread shutdown complete")

        # Reset so a reused bus can subscribe to a fresh stream and spin up a
        # new worker. The reference to a worker that has not ended is kept:
        # dropping it would let a reused bus start a second worker on the same
        # queue while the first one is still reading from it. The next worker
        # installs its own shutdown event when it starts.
        self._completed = False
        if worker_ended:
            self._worker_thread = None
        self._subscription = None

        self.logger.info("Drain completed")

    def is_completed(self) -> bool:
        """
        Returns whether all events have been processed.
        """
        return self._completed and self._event_queue.empty()
