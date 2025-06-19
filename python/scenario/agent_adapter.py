"""
Agent adapter module for integrating custom agents with the Scenario framework.

This module provides the abstract base class that users must implement to integrate
their existing agents with the Scenario testing framework. The adapter pattern allows
any agent implementation to work with the framework regardless of its underlying
architecture or API.
"""

from abc import ABC, abstractmethod
from typing import ClassVar

from .types import AgentInput, AgentReturnTypes, AgentRole


class AgentAdapter(ABC):
    """
    Abstract base class for integrating custom agents with the Scenario framework.

    This adapter pattern allows you to wrap any existing agent implementation
    (LLM calls, agent frameworks, or complex multi-step systems) to work with
    the Scenario testing framework. The adapter receives structured input about
    the conversation state and returns responses in a standardized format.

    Attributes:
        role: The role this agent plays in scenarios (USER, AGENT, or JUDGE)

    Example:
        ```
        import scenario
        from my_agent import MyCustomAgent

        class MyAgentAdapter(scenario.AgentAdapter):
            def __init__(self):
                self.agent = MyCustomAgent()

            async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
                # Get the latest user message
                user_message = input.last_new_user_message_str()

                # Call your existing agent
                response = await self.agent.process(
                    message=user_message,
                    history=input.messages,
                    thread_id=input.thread_id
                )

                # Return the response (can be string, message dict, or list of messages)
                return response

        # Use in a scenario
        result = await scenario.run(
            name="test my agent",
            description="User asks for help with a coding problem",
            agents=[
                MyAgentAdapter(),
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Provides helpful coding advice"])
            ]
        )
        ```

    Note:
        - The call method must be async
        - Return types can be: str, ChatCompletionMessageParam, List[ChatCompletionMessageParam], or ScenarioResult
        - For stateful agents, use input.thread_id to maintain conversation context
        - For stateless agents, use input.messages for the full conversation history
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT

    @abstractmethod
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Process the input and generate a response.

        This is the main method that your agent implementation must provide.
        It receives structured information about the current conversation state
        and must return a response in one of the supported formats.

        Args:
            input: AgentInput containing conversation history, thread context, and scenario state

        Returns:
            AgentReturnTypes: The agent's response, which can be:

                - str: Simple text response

                - ChatCompletionMessageParam: Single OpenAI-format message

                - List[ChatCompletionMessageParam]: Multiple messages for complex responses

                - ScenarioResult: Direct test result (typically only used by judge agents)

        Example:
            ```
            async def call(self, input: AgentInput) -> AgentReturnTypes:
                # Simple string response
                user_msg = input.last_new_user_message_str()
                return f"I understand you said: {user_msg}"

                # Or structured message response
                return {
                    "role": "assistant",
                    "content": "Let me help you with that...",
                }

                # Or multiple messages for complex interactions
                return [
                    {"role": "assistant", "content": "Let me search for that information..."},
                    {"role": "assistant", "content": "Here's what I found: ..."}
                ]
            ```
        """
        pass
