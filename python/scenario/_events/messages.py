"""
Exports message models from the generated LangWatch API client,
renaming the auto-generated types to clean, meaningful names.

This ensures all message types are always in sync with the OpenAPI spec and
the backend, and provides a single import location for message models.

If you need to add custom logic or helpers, you can extend or wrap these models here.
"""

from typing import Union, TypeAlias
from scenario._generated.langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType2MessagesItemType0,
    PostApiScenarioEventsBodyType2MessagesItemType1,
    PostApiScenarioEventsBodyType2MessagesItemType2,
    PostApiScenarioEventsBodyType2MessagesItemType3,
    PostApiScenarioEventsBodyType2MessagesItemType4,
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem,
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction,
)

# Create aliases for cleaner naming
DeveloperMessage: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType0
SystemMessage: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType1
AssistantMessage: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType2
UserMessage: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType3
ToolMessage: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType4
ToolCall: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem
FunctionCall: TypeAlias = PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction

# Union type for all supported message types
MessageType = Union[
    DeveloperMessage,
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
]

__all__ = [
    "MessageType",
    "DeveloperMessage",
    "SystemMessage",
    "AssistantMessage",
    "UserMessage",
    "ToolMessage",
    "ToolCall",
    "FunctionCall",

    # API client models -- Required for PDocs
    "PostApiScenarioEventsBodyType2MessagesItemType0",
    "PostApiScenarioEventsBodyType2MessagesItemType1",
    "PostApiScenarioEventsBodyType2MessagesItemType2",
    "PostApiScenarioEventsBodyType2MessagesItemType3",
    "PostApiScenarioEventsBodyType2MessagesItemType4",
    "PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem",
    "PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction",
]