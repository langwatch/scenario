"""
Utility functions for scenario execution and message handling.

This module provides various utility functions used throughout the Scenario framework,
including message formatting, validation, role reversal, and UI components like spinners
for better user experience during scenario execution.
"""

from contextlib import contextmanager
import sys
from typing import (
    Any,
    Iterator,
    Optional,
    Union,
    TypeVar,
    Awaitable,
)
from pydantic import BaseModel
import copy

import json

import termcolor
from textwrap import indent
from openai.types.chat import ChatCompletionMessageParam
from rich.live import Live
from rich.spinner import Spinner
from rich.console import Console
from rich.text import Text
from rich.errors import LiveError

from scenario._error_messages import message_return_error_message
from scenario.types import ScenarioResult

T = TypeVar("T")


class SerializableAndPydanticEncoder(json.JSONEncoder):
    """
    JSON encoder that handles Pydantic models and iterators.

    This encoder extends the standard JSON encoder to handle Pydantic BaseModel
    instances and iterator objects, converting them to serializable formats.
    Used for caching and logging scenarios that contain complex objects.

    Example:
        ```
        data = {
            "model": SomeBaseModel(field="value"),
            "iterator": iter([1, 2, 3])
        }
        json.dumps(data, cls=SerializableAndPydanticEncoder)
        ```
    """
    def default(self, o: Any) -> Any:
        if isinstance(o, BaseModel):
            return o.model_dump(exclude_unset=True)
        if isinstance(o, Iterator):
            return list(o)
        return super().default(o)


class SerializableWithStringFallback(SerializableAndPydanticEncoder):
    """
    JSON encoder with string fallback for non-serializable objects.

    This encoder extends SerializableAndPydanticEncoder by providing a string
    fallback for any object that cannot be serialized normally. This ensures
    that logging and caching operations never fail due to serialization issues.

    Example:
        ```
        # This will work even with complex non-serializable objects
        data = {"function": lambda x: x, "complex_object": SomeComplexClass()}
        json.dumps(data, cls=SerializableWithStringFallback)
        # Result: {"function": "<function <lambda> at 0x...>", "complex_object": "..."}
        ```
    """
    def default(self, o: Any) -> Any:
        try:
            return super().default(o)
        except:
            return str(o)


def safe_list_at(list_obj: list, index: int, default: Any = None) -> Any:
    """
    Safely get an item from a list by index with a default fallback.

    Args:
        list_obj: The list to access
        index: The index to retrieve
        default: Value to return if index is out of bounds

    Returns:
        The item at the index, or the default value if index is invalid

    Example:
        ```
        items = ["a", "b", "c"]
        print(safe_list_at(items, 1))    # "b"
        print(safe_list_at(items, 10))   # None
        print(safe_list_at(items, 10, "default"))  # "default"
        ```
    """
    try:
        return list_obj[index]
    except:
        return default


def safe_attr_or_key(obj: Any, attr_or_key: str, default: Any = None) -> Any:
    """
    Safely get an attribute or dictionary key from an object.

    Tries to get the value as an attribute first, then as a dictionary key,
    returning the default if neither exists.

    Args:
        obj: Object to access (can have attributes or be dict-like)
        attr_or_key: Name of attribute or key to retrieve
        default: Value to return if attribute/key doesn't exist

    Returns:
        The attribute/key value, or the default if not found

    Example:
        ```
        class MyClass:
            attr = "value"

        obj = MyClass()
        dict_obj = {"key": "value"}

        print(safe_attr_or_key(obj, "attr"))     # "value"
        print(safe_attr_or_key(dict_obj, "key")) # "value"
        print(safe_attr_or_key(obj, "missing"))  # None
        ```
    """
    return getattr(obj, attr_or_key, getattr(obj, 'get', lambda x, default=None: default)(attr_or_key, default))


def title_case(string: str) -> str:
    """
    Convert snake_case string to Title Case.

    Args:
        string: Snake_case string to convert

    Returns:
        String converted to Title Case

    Example:
        ```
        print(title_case("user_simulator_agent"))  # "User Simulator Agent"
        print(title_case("api_key"))               # "Api Key"
        ```
    """
    return " ".join(word.capitalize() for word in string.split("_"))


def print_openai_messages(
    scenario_name: str, messages: list[ChatCompletionMessageParam]
):
    """
    Print OpenAI-format messages with colored formatting for readability.

    This function formats and prints conversation messages with appropriate
    colors and formatting for different message types (user, assistant, tool calls, etc.).
    Used for verbose output during scenario execution.

    Args:
        scenario_name: Name of the scenario (used as prefix)
        messages: List of OpenAI-compatible messages to print

    Example:
        ```
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "assistant", "tool_calls": [{"function": {"name": "search"}}]}
        ]
        print_openai_messages("Test Scenario", messages)
        ```

    Note:
        - User messages are printed in green
        - Assistant messages are printed in blue
        - Tool calls are printed in magenta with formatted JSON
        - Long JSON content is truncated for readability
    """
    for msg in messages:
        role = safe_attr_or_key(msg, "role")
        content = safe_attr_or_key(msg, "content")
        if role == "assistant":
            tool_calls = safe_attr_or_key(msg, "tool_calls")
            if content:
                print(scenario_name + termcolor.colored("Agent:", "blue"), content)
            if tool_calls:
                for tool_call in tool_calls:
                    function = safe_attr_or_key(tool_call, "function")
                    name = safe_attr_or_key(function, "name")
                    args = safe_attr_or_key(function, "arguments", "{}")
                    args = _take_maybe_json_first_lines(args)
                    print(
                        scenario_name
                        + termcolor.colored(f"ToolCall({name}):", "magenta"),
                        f"\n\n{indent(args, ' ' * 4)}\n",
                    )
        elif role == "user":
            print(scenario_name + termcolor.colored("User:", "green"), content)
        elif role == "tool":
            content = _take_maybe_json_first_lines(content or msg.__repr__())
            print(
                scenario_name + termcolor.colored(f"ToolResult:", "magenta"),
                f"\n\n{indent(content, ' ' * 4)}\n",
            )
        else:
            print(
                scenario_name + termcolor.colored(f"{title_case(role)}:", "magenta"),
                msg.__repr__(),
            )


def _take_maybe_json_first_lines(string: str, max_lines: int = 5) -> str:
    """
    Truncate string content and format JSON if possible.

    Internal utility function that attempts to format content as JSON
    and truncates it to a reasonable number of lines for display.

    Args:
        string: Content to format and truncate
        max_lines: Maximum number of lines to show

    Returns:
        Formatted and potentially truncated string
    """
    content = str(string)
    try:
        content = json.dumps(json.loads(content), indent=2)
    except:
        pass
    content = content.split("\n")
    if len(content) > max_lines:
        content = content[:max_lines] + ["..."]
    return "\n".join(content)


console = Console()


class TextFirstSpinner(Spinner):
    """
    Custom spinner that displays text before the spinning animation.

    This class extends Rich's Spinner to show descriptive text followed
    by the spinning animation, improving the user experience during
    scenario execution by clearly indicating what operation is happening.

    Args:
        name: Name of the spinner animation style
        text: Descriptive text to show before the spinner
        color: Color for the descriptive text
        **kwargs: Additional arguments passed to the base Spinner class
    """
    def __init__(self, name: str, text: str, color: str, **kwargs: Any) -> None:
        super().__init__(
            name, "", style="bold white", **kwargs
        )  # Initialize with empty text
        self.text_before = text
        self.color = color

    def render(self, time: float) -> Text:
        # Get the original spinner frame
        spinner_frame = super().render(time)
        # Create a composite with text first, then spinner
        return Text(f"{self.text_before} ", style=self.color) + spinner_frame


@contextmanager
def show_spinner(
    text: str, color: str = "white", enabled: Optional[Union[bool, int]] = None
):
    """
    Context manager for displaying a spinner during long-running operations.

    Shows a spinning indicator with descriptive text while code executes
    within the context. Automatically cleans up the spinner display when
    the operation completes.

    Args:
        text: Descriptive text to show next to the spinner
        color: Color for the descriptive text
        enabled: Whether to show the spinner (respects verbose settings)

    Example:
        ```
        with show_spinner("Calling agent...", color="blue", enabled=True):
            response = await agent.call(input_data)

        # Spinner automatically disappears when block completes
        print("Agent call completed")
        ```

    Note:
        - Spinner is automatically cleaned up when context exits
        - Gracefully handles multi-threading scenarios where multiple spinners might conflict
        - Cursor positioning ensures clean terminal output
    """
    if not enabled:
        yield
    else:
        spinner = TextFirstSpinner("dots", text, color=color)
        try:
            with Live(spinner, console=console, refresh_per_second=20):
                yield
        # It happens when we are multi-threading, it's fine, just ignore it, you probably don't want multiple spinners at once anyway
        except LiveError:
            yield

        # Cursor up one line
        sys.stdout.write("\033[F")
        # Erase the line
        sys.stdout.write("\033[2K")


def check_valid_return_type(return_value: Any, class_name: str) -> None:
    """
    Validate that an agent's return value is in the expected format.

    This function ensures that agent adapters return values in one of the
    supported formats (string, OpenAI message, list of messages, or ScenarioResult).
    It also verifies that the returned data is JSON-serializable for caching.

    Args:
        return_value: The value returned by an agent's call method
        class_name: Name of the agent class (for error messages)

    Raises:
        ValueError: If the return value is not in a supported format

    Example:
        ```
        # Valid return values
        check_valid_return_type("Hello world", "MyAgent")  # OK
        check_valid_return_type({"role": "assistant", "content": "Hi"}, "MyAgent")  # OK
        check_valid_return_type([{"role": "assistant", "content": "Hi"}], "MyAgent")  # OK

        # Invalid return value
        check_valid_return_type(42, "MyAgent")  # Raises ValueError
        ```
    """
    def _is_valid_openai_message(message: Any) -> bool:
        return (isinstance(message, dict) and "role" in message) or (
            isinstance(message, BaseModel) and hasattr(message, "role")
        )

    if (
        isinstance(return_value, str)
        or _is_valid_openai_message(return_value)
        or (
            isinstance(return_value, list)
            and all(_is_valid_openai_message(message) for message in return_value)
        )
        or isinstance(return_value, ScenarioResult)
    ):
        try:
            json.dumps(return_value, cls=SerializableAndPydanticEncoder)
        except:
            raise ValueError(
                message_return_error_message(got=return_value, class_name=class_name)
            )

        return

    raise ValueError(
        message_return_error_message(got=return_value, class_name=class_name)
    )


def reverse_roles(
    messages: list[ChatCompletionMessageParam],
) -> list[ChatCompletionMessageParam]:
    """
    Reverses the roles of the messages in the list.

    Args:
        messages: The list of messages to reverse the roles of.
    """

    reversed_messages = []
    for message in messages:
        message = copy.deepcopy(message)
        # Can't reverse tool calls
        if not safe_attr_or_key(message, "content") or safe_attr_or_key(
            message, "tool_calls"
        ):
            # If no content nor tool calls, we should skip it entirely, as anthropic may generate some invalid ones e.g. pure {"role": "assistant"}
            if safe_attr_or_key(message, "tool_calls"):
                reversed_messages.append(message)
            continue

        if type(message) == dict:
            if message["role"] == "user":
                message["role"] = "assistant"
            elif message["role"] == "assistant":
                message["role"] = "user"
        else:
            if getattr(message, "role", None) == "user":
                message.role = "assistant"  # type: ignore
            elif getattr(message, "role", None) == "assistant":
                message.role = "user"  # type: ignore

        reversed_messages.append(message)

    return reversed_messages


async def await_if_awaitable(value: T) -> T:
    if isinstance(value, Awaitable):
        return await value
    else:
        return value
