"""
Scenario events module for handling event publishing, processing, and reporting.

This module provides event models, an event bus for processing, and utilities
for converting between different message formats.
"""

# Core event types and models
from .events import (
    ScenarioEvent,
    ScenarioRunStartedEvent,
    ScenarioRunStartedEventMetadata,
    ScenarioRunFinishedEvent,
    ScenarioRunFinishedEventResults,
    ScenarioRunFinishedEventVerdict,
    ScenarioRunFinishedEventStatus,
    ScenarioMessageSnapshotEvent,
    MessageType,
)

from scenario.generated.langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType0Metadata,
    PostApiScenarioEventsBodyType1,
    PostApiScenarioEventsBodyType1ResultsType0,
    PostApiScenarioEventsBodyType1ResultsType0Verdict,
    PostApiScenarioEventsBodyType1Status,
    PostApiScenarioEventsBodyType2,
    PostApiScenarioEventsBodyType2MessagesItemType1,
    PostApiScenarioEventsBodyType2MessagesItemType2,
    PostApiScenarioEventsBodyType2MessagesItemType3,
    PostApiScenarioEventsBodyType2MessagesItemType4,
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem,
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction,
)

# Event processing infrastructure
from .event_bus import ScenarioEventBus
from .event_reporter import EventReporter

# Message utilities and types
from .messages import (
    UserMessage,
    AssistantMessage,
    SystemMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
)

# Utility functions
from .utils import convert_messages_to_api_client_messages

__all__ = [
    # Event types
    "ScenarioEvent",
    "ScenarioRunStartedEvent",
    "ScenarioRunStartedEventMetadata",
    "ScenarioRunFinishedEvent", 
    "ScenarioRunFinishedEventResults",
    "ScenarioRunFinishedEventVerdict",
    "ScenarioRunFinishedEventStatus",
    "ScenarioMessageSnapshotEvent",

    # API client models -- Required for PDocs
    "PostApiScenarioEventsBodyType0Metadata",
    "PostApiScenarioEventsBodyType1",
    "PostApiScenarioEventsBodyType1ResultsType0",
    "PostApiScenarioEventsBodyType1ResultsType0Verdict",
    "PostApiScenarioEventsBodyType1Status",
    "PostApiScenarioEventsBodyType2",
    "PostApiScenarioEventsBodyType2MessagesItemType1",
    "PostApiScenarioEventsBodyType2MessagesItemType2",
    "PostApiScenarioEventsBodyType2MessagesItemType3",
    "PostApiScenarioEventsBodyType2MessagesItemType4",
    "PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem",
    "PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction",

    # Event processing
    "ScenarioEventBus",
    "EventReporter",
    
    # Messages
    "MessageType",
    "UserMessage",
    "AssistantMessage", 
    "SystemMessage",
    "ToolMessage",
    "ToolCall",
    "FunctionCall",
    
    # Utils
    "convert_messages_to_api_client_messages",
] 