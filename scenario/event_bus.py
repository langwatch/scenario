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
    Events are processed concurrently.
    """
    
    def __init__(self, event_reporter: Optional[EventReporter] = None, max_retries: int = 3):
        self._events = Subject()
        # Use default EventReporter if none provided
        self._event_reporter: EventReporter = event_reporter or EventReporter()
        self._processing_complete = asyncio.Event()
        self._processing_task: Optional[asyncio.Task[Any]] = None
        self._max_retries = max_retries
        
    def publish(self, event: ScenarioEvent) -> None:
        """
        Publishes an event into the processing pipeline.
        Ensures event has a timestamp (as Unix timestamp in milliseconds).
        """
        # Convert to Unix timestamp in milliseconds
        event.timestamp = int(datetime.now(UTC).timestamp() * 1000)
        self._events.on_next(event)
        
        if isinstance(event, ScenarioRunFinishedEvent):
            self._events.on_completed()
    
    async def listen(self) -> None:
        """
        Begins listening for and processing events.
        """
        if self._processing_task is not None:
            return
            
        async def process_single_event(event: ScenarioEvent, attempt: int = 1) -> bool:
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
        """
        await self._processing_complete.wait()

    def is_completed(self) -> bool:
        """
        Returns whether the event bus has completed processing all events.
        """
        return self._processing_complete.is_set() 