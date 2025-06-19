"""
Message conversion utilities for scenario execution.

This module provides functions for converting between different message formats
used in scenario execution, particularly for normalizing agent return types
to OpenAI-compatible message formats.
"""

import json
from typing import Any, List, Literal, TypeVar, cast
from pydantic import BaseModel
from openai.types.chat import ChatCompletionMessageParam

from scenario.types import AgentReturnTypes, ScenarioResult
from .utils import SerializableAndPydanticEncoder

T = TypeVar("T")


def convert_agent_return_types_to_openai_messages(
    agent_response: AgentReturnTypes, role: Literal["user", "assistant"]
) -> List[ChatCompletionMessageParam]:
    """
    Convert various agent return types to standardized OpenAI message format.

    This function normalizes different return types from agent adapters into
    a consistent list of OpenAI-compatible messages that can be used throughout
    the scenario execution pipeline.

    Args:
        agent_response: Response from an agent adapter call
        role: The role to assign to string responses ("user" or "assistant")

    Returns:
        List of OpenAI-compatible messages

    Raises:
        ValueError: If agent_response is a ScenarioResult (which should be handled separately)

    Example:
        ```
        # String response
        messages = convert_agent_return_types_to_openai_messages("Hello", "assistant")
        # Result: [{"role": "assistant", "content": "Hello"}]

        # Dict response
        response = {"role": "assistant", "content": "Hi", "tool_calls": [...]}
        messages = convert_agent_return_types_to_openai_messages(response, "assistant")
        # Result: [{"role": "assistant", "content": "Hi", "tool_calls": [...]}]

        # List response
        responses = [
            {"role": "assistant", "content": "Thinking..."},
            {"role": "assistant", "content": "Here's the answer"}
        ]
        messages = convert_agent_return_types_to_openai_messages(responses, "assistant")
        # Result: Same list, validated and normalized
        ```
    """
    if isinstance(agent_response, ScenarioResult):
        raise ValueError(
            "Unexpectedly tried to convert a ScenarioResult to openai messages",
            agent_response.__repr__(),
        )

    def convert_maybe_object_to_openai_message(
        obj: Any,
    ) -> ChatCompletionMessageParam:
        if isinstance(obj, dict):
            return cast(ChatCompletionMessageParam, obj)
        elif isinstance(obj, BaseModel):
            return cast(
                ChatCompletionMessageParam,
                obj.model_dump(
                    exclude_unset=True,
                    exclude_none=True,
                    exclude_defaults=True,
                    warnings=False,
                ),
            )
        else:
            raise ValueError(f"Unexpected agent response type: {type(obj).__name__}")

    def ensure_dict(
        obj: T,
    ) -> T:
        return json.loads(json.dumps(obj, cls=SerializableAndPydanticEncoder))

    if isinstance(agent_response, str):
        return [
            (
                {"role": "user", "content": agent_response}
                if role == "user"
                else {"role": "assistant", "content": agent_response}
            )
        ]
    elif isinstance(agent_response, list):
        return [
            ensure_dict(convert_maybe_object_to_openai_message(message))
            for message in agent_response
        ]
    else:
        return [ensure_dict(convert_maybe_object_to_openai_message(agent_response))] 