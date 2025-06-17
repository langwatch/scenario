"""
Exports scenario event models from the generated LangWatch API client,
renaming the auto-generated types to clean, meaningful names.

This ensures all event types are always in sync with the OpenAPI spec and
the backend, and provides a single import location for event models.

If you need to add custom logic or helpers, you can extend or wrap these models here.
"""

from typing import Union

from langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType0,
    PostApiScenarioEventsBodyType0Metadata as ScenarioRunStartedEventMetadata,
    PostApiScenarioEventsBodyType1,
    PostApiScenarioEventsBodyType1ResultsType0 as ScenarioRunFinishedEventResults,
    PostApiScenarioEventsBodyType1ResultsType0Verdict as ScenarioRunFinishedEventVerdict,
    PostApiScenarioEventsBodyType1Status as ScenarioRunFinishedEventStatus,
    PostApiScenarioEventsBodyType2,
    # No separate metadata types for finished or snapshot events
)

# Auto-generate the event classes with the correct type_ attribute

class ScenarioRunStartedEvent(PostApiScenarioEventsBodyType0):
    """
    Event published when a scenario run begins execution.
    
    Automatically sets type_ to "SCENARIO_RUN_STARTED" and includes metadata
    about the scenario (name, description, etc.).
    
    Args:
        batch_run_id (str): Unique identifier for the batch of scenario runs
        scenario_id (str): Unique identifier for the scenario definition
        scenario_run_id (str): Unique identifier for this specific run
        metadata (ScenarioRunStartedEventMetadata): Scenario details like name and description
        timestamp (int, optional): Unix timestamp in milliseconds, auto-generated if not provided
        scenario_set_id (str, optional): Set identifier, defaults to "default"
    """
    def __init__(self, *args, type_="SCENARIO_RUN_STARTED", **kwargs):
        super().__init__(*args, type_=type_, **kwargs)

class ScenarioRunFinishedEvent(PostApiScenarioEventsBodyType1):
    """
    Event published when a scenario run completes execution.
    
    Automatically sets type_ to "SCENARIO_RUN_FINISHED" and includes results
    with verdict (PASS/FAIL/SUCCESS) and reasoning.
    
    Args:
        batch_run_id (str): Unique identifier for the batch of scenario runs
        scenario_id (str): Unique identifier for the scenario definition
        scenario_run_id (str): Unique identifier for this specific run
        status (ScenarioRunFinishedEventStatus): Overall execution status
        results (ScenarioRunFinishedEventResults): Verdict and reasoning for the outcome
        timestamp (int, optional): Unix timestamp in milliseconds, auto-generated if not provided
        scenario_set_id (str, optional): Set identifier, defaults to "default"
    """
    def __init__(self, *args, type_="SCENARIO_RUN_FINISHED", **kwargs):
        super().__init__(*args, type_=type_, **kwargs)

class ScenarioMessageSnapshotEvent(PostApiScenarioEventsBodyType2):
    """
    Event published to capture intermediate state during scenario execution.
    
    Automatically sets type_ to "SCENARIO_MESSAGE_SNAPSHOT" and allows tracking
    of messages, context, or other runtime data during scenario processing.
    
    Args:
        batch_run_id (str): Unique identifier for the batch of scenario runs
        scenario_id (str): Unique identifier for the scenario definition
        scenario_run_id (str): Unique identifier for this specific run
        timestamp (int, optional): Unix timestamp in milliseconds, auto-generated if not provided
        scenario_set_id (str, optional): Set identifier, defaults to "default"
    """
    def __init__(self, *args, type_="SCENARIO_MESSAGE_SNAPSHOT", **kwargs):
        super().__init__(*args, type_=type_, **kwargs)

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