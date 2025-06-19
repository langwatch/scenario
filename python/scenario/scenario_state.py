"""
Scenario state management module.

This module provides the ScenarioState class which tracks the current state
of a scenario execution, including conversation history, turn tracking, and
utility methods for inspecting the conversation.
"""

from typing import List, Dict, Any, Optional, TYPE_CHECKING
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCallParam,
    ChatCompletionUserMessageParam,
)
from pydantic import BaseModel

from scenario.config import ScenarioConfig

if TYPE_CHECKING:
    from .scenario_executor import ScenarioExecutor


class ScenarioState(BaseModel):
    """
    Represents the current state of a scenario execution.

    This class provides access to the conversation history, turn information,
    and utility methods for inspecting messages and tool calls. It's passed to
    script step functions and available through AgentInput.scenario_state.

    Attributes:
        description: The scenario description that guides the simulation
        messages: Complete conversation history as OpenAI-compatible messages
        thread_id: Unique identifier for this conversation thread
        current_turn: Current turn number in the conversation
        config: Configuration settings for this scenario execution

    Example:
        ```
        def check_agent_behavior(state: ScenarioState) -> None:
            # Check if the agent called a specific tool
            if state.has_tool_call("get_weather"):
                print("Agent successfully called weather tool")

            # Get the last user message
            last_user = state.last_user_message()
            print(f"User said: {last_user['content']}")

            # Check conversation length
            if len(state.messages) > 10:
                print("Conversation is getting long")

        # Use in scenario script
        result = await scenario.run(
            name="tool usage test",
            description="Test that agent uses the correct tools",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides helpful response"])
            ],
            script=[
                scenario.user("What's the weather like?"),
                scenario.agent(),
                check_agent_behavior,  # Custom inspection function
                scenario.succeed()
            ]
        )
        ```
    """
    description: str
    messages: List[ChatCompletionMessageParam]
    thread_id: str
    current_turn: int
    config: ScenarioConfig

    _executor: "ScenarioExecutor"

    def add_message(self, message: ChatCompletionMessageParam):
        """
        Add a message to the conversation history.

        This method delegates to the scenario executor to properly handle
        message broadcasting and state updates.

        Args:
            message: OpenAI-compatible message to add to the conversation

        Example:
            ```
            def inject_system_message(state: ScenarioState) -> None:
                state.add_message({
                    "role": "system",
                    "content": "The user is now in a hurry"
                })
            ```
        """
        self._executor.add_message(message)

    def last_message(self) -> ChatCompletionMessageParam:
        """
        Get the most recent message in the conversation.

        Returns:
            The last message in the conversation history

        Raises:
            ValueError: If no messages exist in the conversation

        Example:
            ```
            def check_last_response(state: ScenarioState) -> None:
                last = state.last_message()
                if last["role"] == "assistant":
                    content = last.get("content", "")
                    assert "helpful" in content.lower()
            ```
        """
        if len(self.messages) == 0:
            raise ValueError("No messages found")
        return self.messages[-1]

    def last_user_message(self) -> ChatCompletionUserMessageParam:
        """
        Get the most recent user message in the conversation.

        Returns:
            The last user message in the conversation history

        Raises:
            ValueError: If no user messages exist in the conversation

        Example:
            ```
            def analyze_user_intent(state: ScenarioState) -> None:
                user_msg = state.last_user_message()
                content = user_msg["content"]

                if isinstance(content, str):
                    if "urgent" in content.lower():
                        print("User expressed urgency")
            ```
        """
        user_messages = [m for m in self.messages if m["role"] == "user"]
        if not user_messages:
            raise ValueError("No user messages found")
        return user_messages[-1]

    def last_tool_call(
        self, tool_name: str
    ) -> Optional[ChatCompletionMessageToolCallParam]:
        """
        Find the most recent call to a specific tool in the conversation.

        Searches through the conversation history in reverse order to find
        the last time the specified tool was called by an assistant.

        Args:
            tool_name: Name of the tool to search for

        Returns:
            The tool call object if found, None otherwise

        Example:
            ```
            def verify_weather_call(state: ScenarioState) -> None:
                weather_call = state.last_tool_call("get_current_weather")
                if weather_call:
                    args = json.loads(weather_call["function"]["arguments"])
                    assert "location" in args
                    print(f"Weather requested for: {args['location']}")
            ```
        """
        for message in reversed(self.messages):
            if message["role"] == "assistant" and "tool_calls" in message:
                for tool_call in message["tool_calls"]:
                    if tool_call["function"]["name"] == tool_name:
                        return tool_call
        return None

    def has_tool_call(self, tool_name: str) -> bool:
        """
        Check if a specific tool has been called in the conversation.

        This is a convenience method that returns True if the specified
        tool has been called at any point in the conversation.

        Args:
            tool_name: Name of the tool to check for

        Returns:
            True if the tool has been called, False otherwise

        Example:
            ```
            def ensure_tool_usage(state: ScenarioState) -> None:
                # Verify the agent used required tools
                assert state.has_tool_call("search_database")
                assert state.has_tool_call("format_results")

                # Check it didn't use forbidden tools
                assert not state.has_tool_call("delete_data")
            ```
        """
        return self.last_tool_call(tool_name) is not None
