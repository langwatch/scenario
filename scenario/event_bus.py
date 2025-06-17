from rx.subject import Subject
from rx import operators as ops
from typing import Optional
from .events import BaseScenarioEvent, ScenarioRunFinishedEvent
import asyncio

class ScenarioEventBus:
    """
    Manages scenario event publishing, subscription, and processing pipeline using RxPY.
    Mirrors the TypeScript implementation's reactive approach.
    """
    
    def __init__(self, event_reporter=None):
        self._events = Subject()
        self._event_reporter = event_reporter
        self._processing_complete = asyncio.Event()
        self._processing_task: Optional[asyncio.Task] = None
        
    def publish(self, event: BaseScenarioEvent) -> None:
        """
        Publishes an event into the processing pipeline.
        """
        self._events.on_next(event)
        
        # If it's a finish event, complete the stream
        if isinstance(event, ScenarioRunFinishedEvent):
            self._events.on_completed()
    
    async def listen(self) -> None:
        """
        Begins listening for and processing events.
        Returns when a RUN_FINISHED event is fully processed.
        """
        if self._processing_task is not None:
            return
            
        def process_event(event):
            """Processes a single event through the reporter"""
            async def _process():
                try:
                    if self._event_reporter:
                        await self._event_reporter.post_event(event)
                except Exception as e:
                    print(f"Error processing event: {e}")
                    
            # Create and run the coroutine
            loop = asyncio.get_event_loop()
            return loop.create_task(_process())
        
        def on_complete():
            """Called when the event stream is completed"""
            self._processing_complete.set()
            
        def on_error(error):
            """Called when an error occurs in the stream"""
            print(f"Error in event stream: {error}")
            self._processing_complete.set()
            
        # Set up the event processing pipeline
        self._events.pipe(
            ops.flat_map(lambda event: process_event(event))
        ).subscribe(
            on_next=lambda _: None,
            on_completed=on_complete,
            on_error=on_error
        )
    
    async def drain(self) -> None:
        """
        Waits for all events to be processed after the stream is completed.
        """
        await self._processing_complete.wait() 