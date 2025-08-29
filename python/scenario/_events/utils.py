import warnings
from openai.types.chat.chat_completion_message_param import ChatCompletionMessageParam
from .events import MessageType
from .messages import (
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
)
from typing import List
from pksuid import PKSUID

def convert_messages_to_api_client_messages(messages: list[ChatCompletionMessageParam]) -> list[MessageType]:
    """
    Converts OpenAI ChatCompletionMessageParam messages to API client Message format.

    This function transforms messages from OpenAI's format to the API client format
    that matches the expected schema for ScenarioMessageSnapshotEvent.

    Args:
        messages: List of OpenAI ChatCompletionMessageParam messages

    Returns:
        List of API client Message objects

    Raises:
        ValueError: If message role is not supported or message format is invalid
    """

    converted_messages: list[MessageType] = []

    for i, message in enumerate(messages):
        # Generate unique ID for each message
        message_id = message.get("id") or str(PKSUID('scenariomsg'))

        role = message.get("role")
        content = message.get("content")

        if role == "user":
            if not content:
                raise ValueError(f"User message at index {i} missing required content")
            converted_messages.append(UserMessage(
                id=message_id,
                role="user",
                content=str(content)
            ))
        elif role == "assistant":
            # Handle tool calls if present
            tool_calls = message.get("tool_calls")
            api_tool_calls: List[ToolCall] = []

            if tool_calls:
                for tool_call in tool_calls:
                    api_tool_calls.append(ToolCall(
                        id=tool_call.get("id", str(PKSUID('scenariotoolcall'))),
                        type_="function",
                        function=FunctionCall(
                            name=tool_call["function"].get("name", "unknown"),
                            arguments=tool_call["function"].get("arguments", "{}")
                        )
                    ))

            converted_messages.append(AssistantMessage(
                id=message_id,
                role="assistant",
                content=str(content),
                tool_calls=api_tool_calls
            ))
        elif role == "system":
            if not content:
                raise ValueError(f"System message at index {i} missing required content")
            converted_messages.append(SystemMessage(
                id=message_id,
                role="system",
                content=str(content)
            ))
        elif role == "tool":
            tool_call_id = message.get("tool_call_id")
            if not tool_call_id:
                warnings.warn(f"Tool message at index {i} missing required tool_call_id, skipping tool message")
                continue
            if not content:
                warnings.warn(f"Tool message at index {i} missing required content, skipping tool message")
                continue

            converted_messages.append(ToolMessage(
                id=message_id,
                role="tool",
                content=str(content),
                tool_call_id=tool_call_id
            ))
        else:
            raise ValueError(f"Unsupported message role '{role}' at index {i}")

    return converted_messages
