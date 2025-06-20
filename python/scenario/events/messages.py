from scenario.generated.langwatch_api_client.lang_watch_api_client.models import (
    PostApiScenarioEventsBodyType2MessagesItemType1 as SystemMessage,  # system
    PostApiScenarioEventsBodyType2MessagesItemType2 as AssistantMessage,  # assistant
    PostApiScenarioEventsBodyType2MessagesItemType3 as UserMessage,  # system (duplicate?)
    PostApiScenarioEventsBodyType2MessagesItemType4 as ToolMessage,  # tool
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItem as ToolCall,
    PostApiScenarioEventsBodyType2MessagesItemType2ToolCallsItemFunction as FunctionCall,
)

__all__ = [
    "SystemMessage",
    "AssistantMessage", 
    "UserMessage",
    "ToolMessage",
    "ToolCall",
    "FunctionCall",
]