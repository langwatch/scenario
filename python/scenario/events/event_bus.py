from rx.subject.subject import Subject
from rx import operators as ops
from typing import Optional
from datetime import datetime, UTC
from .events import ScenarioEvent, ScenarioRunFinishedEvent
from .event_reporter import EventReporter
from typing import Any

import asyncio


class ScenarioEventBus:
    """
    Manages scenario event publishing, subscription, and processing pipeline using RxPY.
    
    The EventBus provides a centralized event processing system that handles scenario
    events asynchronously with retry logic and concurrent processing. It automatically
    manages the event stream lifecycle and ensures all events are processed before
    completion.
    
    Events are processed concurrently to improve performance, and failed event
    processing is automatically retried with exponential backoff.
    
    Attributes:
        _events: RxPY Subject for event stream management
        _event_reporter: EventReporter instance for HTTP posting of events
        _processing_complete: Async event to signal when all events are processed
        _processing_task: Background task for event processing
        _max_retries: Maximum number of retry attempts for failed event processing
        
    Example:
        ```python
        # Create event bus with custom reporter
        reporter = EventReporter(endpoint="https://api.example.com")
        event_bus = ScenarioEventBus(event_reporter=reporter, max_retries=5)
        
        # Start listening for events
        await event_bus.listen()
        
        # Publish events
        event_bus.publish(scenario_started_event)
        event_bus.publish(message_snapshot_event)
        event_bus.publish(scenario_finished_event)  # This completes the stream
        
        # Wait for all events to be processed
        await event_bus.drain()
        ```
    """
    
    def __init__(self, event_reporter: Optional[EventReporter] = None, max_retries: int = 3):
        """
        Initialize the event bus with optional event reporter and retry configuration.
        
        Args:
            event_reporter: Optional EventReporter for HTTP posting of events.
                          If not provided, a default EventReporter will be created.
            max_retries: Maximum number of retry attempts for failed event processing.
                       Defaults to 3 attempts with exponential backoff.
        """
        self._events = Subject()
        # Use default EventReporter if none provided
        self._event_reporter: EventReporter = event_reporter or EventReporter()
        self._processing_complete = asyncio.Event()
        self._processing_task: Optional[asyncio.Task[Any]] = None
        self._max_retries = max_retries
        
    def publish(self, event: ScenarioEvent) -> None:
        """
        Publishes an event into the processing pipeline.
        
        This method adds an event to the RxPY stream for processing. The event
        timestamp is automatically set to the current time in milliseconds if
        not already provided. Publishing a ScenarioRunFinishedEvent automatically
        completes the event stream.
        
        Args:
            event: The scenario event to publish. Must be a valid ScenarioEvent type.
            
        Note:
            Events are processed asynchronously in the background. Use `drain()`
            to wait for all events to be processed after publishing.
        """
        # Convert to Unix timestamp in milliseconds
        event.timestamp = int(datetime.now(UTC).timestamp() * 1000)
        self._events.on_next(event)
        
        if isinstance(event, ScenarioRunFinishedEvent):
            self._events.on_completed()
    
    async def listen(self) -> None:
        """
        Begins listening for and processing events.
        
        This method sets up the RxPY event processing pipeline with concurrent
        processing and automatic retry logic. It should be called before publishing
        any events to ensure proper event handling.
        
        The processing pipeline:
        1. Receives events from the publish() method
        2. Processes each event concurrently using asyncio tasks
        3. Automatically retries failed events with exponential backoff
        4. Completes when a ScenarioRunFinishedEvent is published
        
        Note:
            This method is idempotent - calling it multiple times has no effect
            if the processing pipeline is already active.
        """
        if self._processing_task is not None:
            return
            
        async def process_single_event(event: ScenarioEvent, attempt: int = 1) -> bool:
            """
            Process a single event with retry logic.
            
            Args:
                event: The event to process
                attempt: Current attempt number (1-based)
                
            Returns:
                True if processing succeeded, False if all retries failed
            """
            try:
                if self._event_reporter:
                    await self._event_reporter.post_event(event)
                return True
            except Exception as e:
                if attempt >= self._max_retries:
                    print(f"Failed to process event after {attempt} attempts: {e}")
                    return False
                print(f"Error processing event (attempt {attempt}/{self._max_retries}): {e}")
                await asyncio.sleep(0.1 * (2 ** (attempt - 1)))
                return await process_single_event(event, attempt + 1)
                    
        def process_event(event: ScenarioEvent) -> asyncio.Task[bool]:
            """Create an asyncio task to process an event concurrently."""
            loop = asyncio.get_event_loop()
            return loop.create_task(process_single_event(event))
        
        # Set up the event processing pipeline with concurrent processing
        self._events.pipe(
            ops.flat_map(lambda event: process_event(event))
        ).subscribe(
            on_next=lambda success: None,
            on_completed=lambda: self._processing_complete.set(),
            on_error=lambda e: print(f"Unexpected error in event stream: {e}")
        )
    
    async def drain(self) -> None:
        """
        Waits for all events to be processed after the stream is completed.
        
        This method blocks until all events in the processing pipeline have been
        handled. It should be called after publishing all events to ensure
        proper cleanup and that no events are lost.
        
        Note:
            This method will wait indefinitely if the event stream has not been
            completed (i.e., if no ScenarioRunFinishedEvent has been published).
        """
        await self._processing_complete.wait()

    def is_completed(self) -> bool:
        """
        Returns whether the event bus has completed processing all events.
        
        This method provides a non-blocking way to check if all events have
        been processed. It's useful for monitoring the state of the event bus
        without blocking execution.
        
        Returns:
            True if all events have been processed, False otherwise
        """
        return self._processing_complete.is_set() 