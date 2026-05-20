import json
import warnings

from ..types import ChatCompletionMessageParamWithTrace
from .events import MessageType
from .messages import (
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
)
from typing import Any, List
from pksuid import PKSUID


def _serialize_content(content: Any) -> str:
    """Coerce message content to the string shape the API client expects.

    Plain strings pass through unchanged. Structured content (a list of
    OpenAI-style content parts, or a dict) is JSON-encoded so downstream
    consumers can parse it. Previously this used ``str(content)``, which
    on a list of dicts produces Python repr with single quotes, breaking
    JSON-based receivers and forcing brittle apostrophe-aware recovery
    in the langwatch backend.
    """
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return json.dumps(content)


def convert_messages_to_api_client_messages(
    messages: list[ChatCompletionMessageParamWithTrace],
) -> list[MessageType]:
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
        message_id = message.get("id") or str(PKSUID("scenariomsg"))

        role = message.get("role")
        content = message.get("content")

        # Only include trace_id in additional_properties when it has a value
        trace_props = {}
        trace_id = message.get("trace_id")
        if trace_id is not None:
            trace_props["trace_id"] = trace_id

        if role == "user":
            if not content:
                raise ValueError(f"User message at index {i} missing required content")
            message_ = UserMessage(
                id=message_id,
                role="user",
                content=_serialize_content(content),
            )
            message_.additional_properties = trace_props
            converted_messages.append(message_)
        elif role == "assistant":
            # Handle tool calls if present
            tool_calls = message.get("tool_calls")
            api_tool_calls: List[ToolCall] = []

            if tool_calls:
                for tool_call in tool_calls:
                    if "function" not in tool_call:
                        continue
                    api_tool_calls.append(
                        ToolCall(
                            id=tool_call.get("id", str(PKSUID("scenariotoolcall"))),
                            type_="function",
                            function=FunctionCall(
                                name=tool_call["function"].get("name", "unknown"),
                                arguments=tool_call["function"].get("arguments", "{}"),
                            ),
                        )
                    )

            message_ = AssistantMessage(
                id=message_id,
                role="assistant",
                content=_serialize_content(content),
                tool_calls=api_tool_calls,
            )
            message_.additional_properties = trace_props
            converted_messages.append(message_)
        elif role == "system":
            if not content:
                raise ValueError(
                    f"System message at index {i} missing required content"
                )
            message_ = SystemMessage(
                id=message_id, role="system", content=_serialize_content(content)
            )
            message_.additional_properties = trace_props
            converted_messages.append(message_)
        elif role == "tool":
            tool_call_id = message.get("tool_call_id")
            if not tool_call_id:
                warnings.warn(
                    f"Tool message at index {i} missing required tool_call_id, skipping tool message"
                )
                continue
            if not content:
                warnings.warn(
                    f"Tool message at index {i} missing required content, skipping tool message"
                )
                continue

            message_ = ToolMessage(
                id=message_id,
                role="tool",
                content=_serialize_content(content),
                tool_call_id=tool_call_id,
            )
            message_.additional_properties = trace_props
            converted_messages.append(message_)
        else:
            raise ValueError(f"Unsupported message role '{role}' at index {i}")

    return converted_messages
