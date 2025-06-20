"""
Exports scenario event models from the generated LangWatch API client,
renaming the auto-generated types to clean, meaningful names.

This ensures all event types are always in sync with the OpenAPI spec and
the backend, and provides a single import location for event models.

If you need to add custom logic or helpers, you can extend or wrap these models here.
"""

from typing import Union, Any, Optional, TypeAlias
from scenario._generated.langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType0,
    PostApiScenarioEventsBodyType0Metadata,
    PostApiScenarioEventsBodyType1,
    PostApiScenarioEventsBodyType1ResultsType0,
    PostApiScenarioEventsBodyType1ResultsType0Verdict,
    PostApiScenarioEventsBodyType1Status,
    PostApiScenarioEventsBodyType2,
)
from .messages import MessageType

# Create alias for cleaner naming
ScenarioRunStartedEventMetadata: TypeAlias = PostApiScenarioEventsBodyType0Metadata
ScenarioRunFinishedEventResults: TypeAlias = PostApiScenarioEventsBodyType1ResultsType0
ScenarioRunFinishedEventVerdict: TypeAlias = PostApiScenarioEventsBodyType1ResultsType0Verdict
ScenarioRunFinishedEventStatus: TypeAlias = PostApiScenarioEventsBodyType1Status


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
        timestamp (Optional[int], optional): Unix timestamp in milliseconds, auto-generated if not provided
        raw_event (Optional[Any], optional): Raw event data
        scenario_set_id (Optional[str], optional): Set identifier, defaults to "default"
    """
    def __init__(
        self,
        batch_run_id: str,
        scenario_id: str,
        scenario_run_id: str,
        metadata: ScenarioRunStartedEventMetadata,
        timestamp: int,
        raw_event: Optional[Any] = None,
        scenario_set_id: Optional[str] = "default"
    ):
        super().__init__(
            type_="SCENARIO_RUN_STARTED",
            batch_run_id=batch_run_id,
            scenario_id=scenario_id,
            scenario_run_id=scenario_run_id,
            metadata=metadata,
            timestamp=timestamp,
            raw_event=raw_event,
            scenario_set_id=scenario_set_id or "default"
        )

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
        timestamp (Optional[int], optional): Unix timestamp in milliseconds, auto-generated if not provided
        raw_event (Optional[Any], optional): Raw event data
        scenario_set_id (Optional[str], optional): Set identifier, defaults to "default"
        results (Optional[ScenarioRunFinishedEventResults], optional): Verdict and reasoning for the outcome
    """
    def __init__(
        self,
        batch_run_id: str,
        scenario_id: str,
        scenario_run_id: str,
        status: ScenarioRunFinishedEventStatus,
        timestamp: int,
        results: Optional[ScenarioRunFinishedEventResults] = None,
        raw_event: Optional[Any] = None,
        scenario_set_id: Optional[str] = "default",
    ):
        super().__init__(
            type_="SCENARIO_RUN_FINISHED",
            batch_run_id=batch_run_id,
            scenario_id=scenario_id,
            scenario_run_id=scenario_run_id,
            status=status,
            timestamp=timestamp,
            raw_event=raw_event,
            scenario_set_id=scenario_set_id or "default",
            results=results
        )

class ScenarioMessageSnapshotEvent(PostApiScenarioEventsBodyType2):
    """
    Event published to capture intermediate state during scenario execution.

    Automatically sets type_ to "SCENARIO_MESSAGE_SNAPSHOT" and allows tracking
    of messages, context, or other runtime data during scenario processing.

    Args:
        batch_run_id (str): Unique identifier for the batch of scenario runs
        scenario_id (str): Unique identifier for the scenario definition
        scenario_run_id (str): Unique identifier for this specific run
        messages (list[MessageType]): List of message objects in the conversation
        timestamp (Optional[int], optional): Unix timestamp in milliseconds, auto-generated if not provided
        raw_event (Optional[Any], optional): Raw event data
        scenario_set_id (Optional[str], optional): Set identifier, defaults to "default"
    """
    def __init__(
        self,
        batch_run_id: str,
        scenario_id: str,
        scenario_run_id: str,
        messages: list[MessageType],
        timestamp: int,
        raw_event: Optional[Any] = None,
        scenario_set_id: Optional[str] = "default"
    ):
        super().__init__(
            type_="SCENARIO_MESSAGE_SNAPSHOT",
            batch_run_id=batch_run_id,
            scenario_id=scenario_id,
            scenario_run_id=scenario_run_id,
            messages=messages,
            timestamp=timestamp,
            raw_event=raw_event,
            scenario_set_id=scenario_set_id or "default"
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
    "MessageType",
]