"""
Exports scenario event models from the generated LangWatch API client,
renaming the auto-generated types to clean, meaningful names.

This ensures all event types are always in sync with the OpenAPI spec and
the backend, and provides a single import location for event models.

If you need to add custom logic or helpers, you can extend or wrap these models here.
"""

from typing import Union

from langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType0 as ScenarioRunStartedEvent,
    PostApiScenarioEventsBodyType0Metadata as ScenarioRunStartedEventMetadata,
    PostApiScenarioEventsBodyType1 as ScenarioRunFinishedEvent,
    PostApiScenarioEventsBodyType1ResultsType0 as ScenarioRunFinishedEventResults,
    PostApiScenarioEventsBodyType1ResultsType0Verdict as ScenarioRunFinishedEventVerdict,
    PostApiScenarioEventsBodyType1Status as ScenarioRunFinishedEventStatus,
    PostApiScenarioEventsBodyType2 as ScenarioMessageSnapshotEvent,
    # No separate metadata types for finished or snapshot events
)
# Union type for all supported event types
ScenarioEvent = Union[
    ScenarioRunStartedEvent,
    ScenarioRunFinishedEvent, 
    ScenarioMessageSnapshotEvent
]

__all__ = [
    "ScenarioEvent",
    "ScenarioRunStartedEvent",
    "ScenarioRunStartedEventMetadata",
    "ScenarioRunFinishedEvent",
    "ScenarioRunFinishedEventResults",
    "ScenarioRunFinishedEventVerdict",
    "ScenarioRunFinishedEventStatus",
    "ScenarioMessageSnapshotEvent",
]