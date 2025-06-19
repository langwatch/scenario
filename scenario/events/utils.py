from openai.types.chat.chat_completion_message_param import ChatCompletionMessageParam
from .messages import UserMessage, AssistantMessage, SystemMessage, ToolMessage, ToolCall, FunctionCall
from typing import List, Union

import uuid

# Define the correct Message type for the return value
Message = Union[UserMessage, AssistantMessage, SystemMessage, ToolMessage]

def convert_messages_to_ag_ui_messages(messages: list[ChatCompletionMessageParam]) -> list[Message]:
    """
    Converts OpenAI ChatCompletionMessageParam messages to ag_ui Message format.
    
    This function transforms messages from OpenAI's format to the ag_ui protocol
    format for consistent message handling across the scenario framework.
    
    Args:
        messages: List of OpenAI ChatCompletionMessageParam messages
        
    Returns:
        List of ag_ui Message objects
        
    Raises:
        ValueError: If message role is not supported or message format is invalid
    """

    converted_messages: list[Message] = []
    
    for i, message in enumerate(messages):
        # Generate unique ID for each message
        message_id = message.get("id") or str(uuid.uuid4())
        
        role = message.get("role")
        content = message.get("content")
        
        if role == "user":
            if not content:
                raise ValueError(f"User message at index {i} missing required content")
            converted_messages.append(UserMessage(
                id=message_id,
                content=str(content)
            ))
        elif role == "assistant":
            # Handle tool calls if present
            tool_calls = message.get("tool_calls")
            ag_ui_tool_calls: List[ToolCall] | None = None
            
            if tool_calls:
                ag_ui_tool_calls = []
                for tool_call in tool_calls:
                    ag_ui_tool_calls.append(ToolCall(
                        id=tool_call.get("id", str(uuid.uuid4())),
                        function=FunctionCall(
                            name=tool_call["function"]["name"],
                            arguments=tool_call["function"]["arguments"]
                        )
                    ))
            
            converted_messages.append(AssistantMessage(
                id=message_id,
                content=str(content) if content else None,
                tool_calls=ag_ui_tool_calls
            ))
        elif role == "system":
            if not content:
                raise ValueError(f"System message at index {i} missing required content")
            converted_messages.append(SystemMessage(
                id=message_id,
                content=str(content)
            ))
        elif role == "tool":
            tool_call_id = message.get("tool_call_id")
            if not tool_call_id:
                raise ValueError(f"Tool message at index {i} missing required tool_call_id")
            if not content:
                raise ValueError(f"Tool message at index {i} missing required content")
                
            converted_messages.append(ToolMessage(
                id=message_id,
                content=str(content),
                tool_call_id=tool_call_id
            ))
        else:
            raise ValueError(f"Unsupported message role '{role}' at index {i}")
    
    return converted_messages
