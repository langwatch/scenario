from enum import Enum
from pydantic import BaseModel, SkipValidation
from typing import (
    TYPE_CHECKING,
    Annotated,
    Any,
    Awaitable,
    Callable,
    List,
    Optional,
    TypeAlias,
    Union,
)

from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionFunctionMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionDeveloperMessageParam,
)

# Prevent circular imports + Pydantic breaking
if TYPE_CHECKING:
    from scenario.scenario_executor import ScenarioState

    ScenarioStateType = ScenarioState
else:
    ScenarioStateType = Any


# Since Python types do not support intersection, we need to wrap ALL the chat completion
# message types with the trace_id field


class ChatCompletionDeveloperMessageParamWithTrace(ChatCompletionDeveloperMessageParam):
    trace_id: Optional[str]


class ChatCompletionSystemMessageParamWithTrace(ChatCompletionSystemMessageParam):
    trace_id: Optional[str]


class ChatCompletionUserMessageParamWithTrace(ChatCompletionUserMessageParam):
    trace_id: Optional[str]


class ChatCompletionAssistantMessageParamWithTrace(ChatCompletionAssistantMessageParam):
    trace_id: Optional[str]


class ChatCompletionToolMessageParamWithTrace(ChatCompletionToolMessageParam):
    trace_id: Optional[str]


class ChatCompletionFunctionMessageParamWithTrace(ChatCompletionFunctionMessageParam):
    trace_id: Optional[str]


"""
A wrapper around ChatCompletionMessageParam that adds a trace_id field to be able to
tie back each message of the scenario run to a trace.
"""
ChatCompletionMessageParamWithTrace: TypeAlias = Union[
    ChatCompletionDeveloperMessageParamWithTrace,
    ChatCompletionSystemMessageParamWithTrace,
    ChatCompletionUserMessageParamWithTrace,
    ChatCompletionAssistantMessageParamWithTrace,
    ChatCompletionToolMessageParamWithTrace,
    ChatCompletionFunctionMessageParamWithTrace,
]


class AgentRole(Enum):
    """
    Defines the different roles that agents can play in a scenario.

    This enum is used to identify the role of each agent during scenario execution,
    enabling the framework to determine the order and interaction patterns between
    different types of agents.

    Attributes:
        USER: Represents a user simulator agent that generates user inputs
        AGENT: Represents the agent under test that responds to user inputs
        JUDGE: Represents a judge agent that evaluates the conversation and determines success/failure
    """

    USER = "User"
    AGENT = "Agent"
    JUDGE = "Judge"


class AgentInput(BaseModel):
    """
    Input data structure passed to agent adapters during scenario execution.

    This class encapsulates all the information an agent needs to generate its next response,
    including conversation history, thread context, and scenario state. It provides convenient
    methods to access the most recent user messages.

    Attributes:
        thread_id: Unique identifier for the conversation thread
        messages: Complete conversation history as OpenAI-compatible messages
        new_messages: Only the new messages since the agent's last call
        judgment_request: Whether this call is requesting a judgment from a judge agent
        scenario_state: Current state of the scenario execution

    Example:
        ```
        class MyAgent(AgentAdapter):
            async def call(self, input: AgentInput) -> str:
                # Get the latest user message
                user_msg = input.last_new_user_message_str()

                # Process with your LLM/agent
                response = await my_llm.complete(
                    messages=input.messages,
                    prompt=user_msg
                )

                return response
        ```
    """

    thread_id: str
    # Prevent pydantic from validating/parsing the messages and causing issues: https://github.com/pydantic/pydantic/issues/9541
    messages: Annotated[List[ChatCompletionMessageParam], SkipValidation]
    new_messages: Annotated[List[ChatCompletionMessageParam], SkipValidation]
    judgment_request: bool = False
    scenario_state: ScenarioStateType

    def last_new_user_message(self) -> ChatCompletionUserMessageParam:
        """
        Get the most recent user message from the new messages.

        Returns:
            The last user message in OpenAI message format

        Raises:
            ValueError: If no new user messages are found

        Example:
            ```
            user_message = input.last_new_user_message()
            content = user_message["content"]
            ```
        """
        user_messages = [m for m in self.new_messages if m["role"] == "user"]
        if not user_messages:
            raise ValueError(
                "No new user messages found, did you mean to call the assistant twice? Perhaps change your adapter to use the full messages list instead."
            )
        return user_messages[-1]

    def last_new_user_message_str(self) -> str:
        """
        Get the content of the most recent user message as a string.

        This is a convenience method for getting simple text content from user messages.
        For multimodal messages or complex content, use last_new_user_message() instead.

        Returns:
            The text content of the last user message

        Raises:
            ValueError: If no new user messages found or if the message content is not a string

        Example:
            ```
            user_text = input.last_new_user_message_str()
            response = f"You said: {user_text}"
            ```
        """
        content = self.last_new_user_message()["content"]
        if type(content) != str:
            raise ValueError(
                f"Last user message is not a string: {content.__repr__()}. Please use the full messages list instead."
            )
        return content


class ScenarioResult(BaseModel):
    """
    Represents the final result of a scenario test execution.

    This class contains all the information about how a scenario performed,
    including whether it succeeded, the conversation that took place, and
    detailed reasoning about which criteria were met or failed.

    Attributes:
        success: Whether the scenario passed all criteria and completed successfully
        messages: Complete conversation history that occurred during the scenario
        reasoning: Detailed explanation of why the scenario succeeded or failed
        passed_criteria: List of success criteria that were satisfied
        failed_criteria: List of success criteria that were not satisfied
        total_time: Total execution time in seconds (if measured)
        agent_time: Time spent in agent calls in seconds (if measured)

    Example:
        ```
        result = await scenario.run(
            name="weather query",
            description="User asks about weather",
            agents=[
                weather_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides helpful weather information"])
            ]
        )

        print(f"Test {'PASSED' if result.success else 'FAILED'}")
        print(f"Reasoning: {result.reasoning}")

        if not result.success:
            print("Failed criteria:")
            for criteria in result.failed_criteria:
                print(f"  - {criteria}")
        ```
    """

    success: bool
    # Prevent issues with slightly inconsistent message types for example when comming from Gemini right at the result level
    messages: Annotated[List[ChatCompletionMessageParamWithTrace], SkipValidation]
    reasoning: Optional[str] = None
    passed_criteria: List[str] = []
    failed_criteria: List[str] = []
    total_time: Optional[float] = None
    agent_time: Optional[float] = None

    def __repr__(self) -> str:
        """
        Provide a concise representation for debugging and logging.

        Returns:
            A string representation showing success status and reasoning
        """
        status = "PASSED" if self.success else "FAILED"
        return f"ScenarioResult(success={self.success}, status={status}, reasoning='{self.reasoning or 'None'}')"


AgentReturnTypes = Union[
    str, ChatCompletionMessageParam, List[ChatCompletionMessageParam], ScenarioResult
]
"""
Union type representing all valid return types for agent adapter call methods.

Agent adapters can return any of these types:

- str: Simple text response

- ChatCompletionMessageParam: Single OpenAI-compatible message

- List[ChatCompletionMessageParam]: Multiple OpenAI-compatible messages (for multi-step responses)

- ScenarioResult: Direct test result (typically used by judge agents to end scenarios)

Example:
    ```
    class MyAgent(AgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            # Can return a simple string
            return "Hello, how can I help you?"

            # Or a structured message
            return {"role": "assistant", "content": "Hello!"}

            # Or multiple messages for complex interactions
            return [
                {"role": "assistant", "content": "Let me search for that..."},
                {"role": "assistant", "content": "Here's what I found: ..."}
            ]
    ```
"""

# TODO: remove the optional ScenarioResult return type from here, use events instead
ScriptStep = Union[
    Callable[["ScenarioState"], None],
    Callable[["ScenarioState"], Optional[ScenarioResult]],
    # Async as well
    Callable[["ScenarioState"], Awaitable[None]],
    Callable[["ScenarioState"], Awaitable[Optional[ScenarioResult]]],
]
"""
Union type for script step functions used in scenario scripts.

Script steps are functions that can be called during scenario execution to control
the flow, add custom assertions, or perform evaluations. They receive the current
scenario state and can optionally return a result to end the scenario.

The functions can be either synchronous or asynchronous.

Example:
    ```
    def check_tool_call(state: ScenarioState) -> None:
        assert state.has_tool_call("get_weather")

    async def custom_evaluation(state: ScenarioState) -> Optional[ScenarioResult]:
        eval_result = await some_external_evaluator(state.messages)
        if not eval_result.passed:
            return ScenarioResult(
                success=False,
                messages=state.messages,
                reasoning="Custom evaluation failed"
            )
        return None  # Continue scenario

    # Use in script
    result = await scenario.run(
        name="test",
        description="Test scenario",
        agents=[
            MyAgent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(criteria=["Agent provides helpful response"])
        ],
        script=[
            scenario.user("What's the weather?"),
            scenario.agent(),
            check_tool_call,
            custom_evaluation,
            scenario.succeed()
        ]
    )
    ```
"""
