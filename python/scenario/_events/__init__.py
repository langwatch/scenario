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