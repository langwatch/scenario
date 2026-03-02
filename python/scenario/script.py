"""
Use the Scenario script DSL to define simulation flows and evaluate AI agent behavior in structured testing environments..

This module provides a collection of functions that form a declarative language
for controlling scenario execution flow. These functions can be used to create
scripts that precisely control how conversations unfold, when evaluations occur,
and when scenarios should succeed or fail.
"""

from typing import Awaitable, Callable, List, Optional, Union, TYPE_CHECKING

from .types import ScriptStep

from openai.types.chat import ChatCompletionMessageParam

if TYPE_CHECKING:
    from scenario.scenario_state import ScenarioState


def message(message: ChatCompletionMessageParam) -> ScriptStep:
    """
    Add a specific message to the conversation.

    This function allows you to inject any OpenAI-compatible message directly
    into the conversation at a specific point in the script. Useful for
    simulating tool responses, system messages, or specific conversational states.

    Args:
        message: OpenAI-compatible message to add to the conversation

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        result = await scenario.run(
            name="tool response test",
            description="Testing tool call responses",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent uses weather tool correctly"])
            ],
            script=[
                scenario.user("What's the weather?"),
                scenario.agent(),  # Agent calls weather tool
                scenario.message({
                    "role": "tool",
                    "tool_call_id": "call_123",
                    "content": json.dumps({"temperature": "75°F", "condition": "sunny"})
                }),
                scenario.agent(),  # Agent processes tool response
                scenario.succeed()
            ]
        )
        ```
    """
    return lambda state: state._executor.message(message)


def user(
    content: Optional[Union[str, ChatCompletionMessageParam]] = None,
) -> ScriptStep:
    """
    Generate or specify a user message in the conversation.

    If content is provided, it will be used as the user message. If no content
    is provided, the user simulator agent will automatically generate an
    appropriate message based on the scenario context.

    Args:
        content: Optional user message content. Can be a string or full message dict.
                If None, the user simulator will generate content automatically.

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        result = await scenario.run(
            name="user interaction test",
            description="Testing specific user inputs",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent responds helpfully to user"])
            ],
            script=[
                # Specific user message
                scenario.user("I need help with Python"),
                scenario.agent(),

                # Auto-generated user message based on scenario context
                scenario.user(),
                scenario.agent(),

                # Structured user message with multimodal content
                scenario.message({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What's in this image?"},
                        {"type": "image_url", "image_url": {"url": "data:image/..."}}
                    ]
                }),
                scenario.succeed()
            ]
        )
        ```
    """
    return lambda state: state._executor.user(content)


def agent(
    content: Optional[Union[str, ChatCompletionMessageParam]] = None,
) -> ScriptStep:
    """
    Generate or specify an agent response in the conversation.

    If content is provided, it will be used as the agent response. If no content
    is provided, the agent under test will be called to generate its response
    based on the current conversation state.

    Args:
        content: Optional agent response content. Can be a string or full message dict.
                If None, the agent under test will generate content automatically.

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        result = await scenario.run(
            name="agent response test",
            description="Testing agent responses",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides appropriate responses"])
            ],
            script=[
                scenario.user("Hello"),

                # Let agent generate its own response
                scenario.agent(),

                # Or specify exact agent response for testing edge cases
                scenario.agent("I'm sorry, I'm currently unavailable"),
                scenario.user(),  # See how user simulator reacts

                # Structured agent response with tool calls
                scenario.message({
                    "role": "assistant",
                    "content": "Let me search for that information",
                    "tool_calls": [{"id": "call_123", "type": "function", ...}]
                }),
                scenario.succeed()
            ]
        )
        ```
    """
    return lambda state: state._executor.agent(content)


def judge(
    criteria: Optional[List[str]] = None,
) -> ScriptStep:
    """
    Invoke the judge agent to evaluate the current conversation state.

    When criteria are provided inline, the judge evaluates only those criteria
    as a checkpoint: if all pass, the scenario continues; if any fail, the
    scenario fails immediately. This is the preferred way to pass criteria
    when using scripts.

    When no criteria are provided, the judge uses its own configured criteria
    and returns a final verdict (success or failure), ending the scenario.

    Args:
        criteria: Optional list of criteria to evaluate inline. When provided,
                 acts as a checkpoint rather than a final judgment.

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        result = await scenario.run(
            name="judge evaluation test",
            description="Testing judge at specific points",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent()
            ],
            script=[
                scenario.user("Can you help me code?"),
                scenario.agent(),

                # Checkpoint: evaluate specific criteria, continue if met
                scenario.judge(criteria=[
                    "Agent should ask clarifying questions about the coding task",
                ]),

                scenario.user(),
                scenario.agent(),

                # Final evaluation with remaining criteria
                scenario.judge(criteria=[
                    "Agent provides working code example",
                    "Agent explains the code clearly",
                ]),
            ]
        )
        ```
    """
    return lambda state: state._executor.judge(criteria=criteria)


def proceed(
    turns: Optional[int] = None,
    on_turn: Optional[
        Union[
            Callable[["ScenarioState"], None],
            Callable[["ScenarioState"], Awaitable[None]],
        ]
    ] = None,
    on_step: Optional[
        Union[
            Callable[["ScenarioState"], None],
            Callable[["ScenarioState"], Awaitable[None]],
        ]
    ] = None,
) -> ScriptStep:
    """
    Let the scenario proceed automatically for a specified number of turns.

    This function allows the scenario to run automatically with the normal
    agent interaction flow (user -> agent -> judge evaluation). You can
    optionally provide callbacks to execute custom logic at each turn or step.

    Args:
        turns: Number of turns to proceed automatically. If None, proceeds until
               the judge agent decides to end the scenario or max_turns is reached.
        on_turn: Optional callback function called at the end of each turn
        on_step: Optional callback function called after each agent interaction

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        def log_progress(state: ScenarioState) -> None:
            print(f"Turn {state.current_turn}: {len(state.messages)} messages")

        def check_tool_usage(state: ScenarioState) -> None:
            if state.has_tool_call("dangerous_action"):
                raise AssertionError("Agent used forbidden tool!")

        result = await scenario.run(
            name="automatic proceeding test",
            description="Let scenario run with monitoring",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent behaves safely and helpfully"])
            ],
            script=[
                scenario.user("Let's start"),
                scenario.agent(),

                # Let it proceed for 3 turns with monitoring
                scenario.proceed(
                    turns=3,
                    on_turn=log_progress,
                    on_step=check_tool_usage
                ),

                # Then do final evaluation
                scenario.judge()
            ]
        )
        ```
    """
    return lambda state: state._executor.proceed(turns, on_turn, on_step)


def succeed(reasoning: Optional[str] = None) -> ScriptStep:
    """
    Immediately end the scenario with a success result.

    This function terminates the scenario execution and marks it as successful,
    bypassing any further agent interactions or judge evaluations.

    Args:
        reasoning: Optional explanation for why the scenario succeeded

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        def custom_success_check(state: ScenarioState) -> None:
            last_msg = state.last_message()
            if "solution" in last_msg.get("content", "").lower():
                # Custom success condition met
                return scenario.succeed("Agent provided a solution")()

        result = await scenario.run(
            name="custom success test",
            description="Test custom success conditions",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides a solution"])
            ],
            script=[
                scenario.user("I need a solution"),
                scenario.agent(),
                custom_success_check,

                # Or explicit success
                scenario.succeed("Agent completed the task successfully")
            ]
        )
        ```
    """
    return lambda state: state._executor.succeed(reasoning)


def fail(reasoning: Optional[str] = None) -> ScriptStep:
    """
    Immediately end the scenario with a failure result.

    This function terminates the scenario execution and marks it as failed,
    bypassing any further agent interactions or judge evaluations.

    Args:
        reasoning: Optional explanation for why the scenario failed

    Returns:
        ScriptStep function that can be used in scenario scripts

    Example:
        ```
        def safety_check(state: ScenarioState) -> None:
            last_msg = state.last_message()
            content = last_msg.get("content", "")

            if "harmful" in content.lower():
                return scenario.fail("Agent produced harmful content")()

        result = await scenario.run(
            name="safety check test",
            description="Test safety boundaries",
            agents=[
                my_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent maintains safety guidelines"])
            ],
            script=[
                scenario.user("Tell me something dangerous"),
                scenario.agent(),
                safety_check,

                # Or explicit failure
                scenario.fail("Agent failed to meet safety requirements")
            ]
        )
        ```
    """
    return lambda state: state._executor.fail(reasoning)


def marathon_script(
    turns: int,
    checks: Optional[List[Callable]] = None,
    final_checks: Optional[List[Callable]] = None,
) -> List[ScriptStep]:
    """Generate a marathon test script.

    Produces ``[user(), agent(), *checks] * turns + [*final_checks, judge()]``.
    Useful for long-running adversarial or endurance tests.

    Args:
        turns: Number of user/agent turn pairs.
        checks: Assertion functions to run after every agent response.
        final_checks: Assertion functions to run once at the end, before judge.

    Returns:
        A list of ``ScriptStep`` items ready for ``scenario.run(script=...)``.
    """
    checks = checks or []
    final_checks = final_checks or []

    script: List[ScriptStep] = []
    for _ in range(turns):
        script.append(user())
        script.append(agent())
        for check in checks:
            script.append(check)

    for check in final_checks:
        script.append(check)

    script.append(judge())
    return script
