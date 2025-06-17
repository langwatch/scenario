"""
Scenario execution engine for agent testing.

This module contains the core ScenarioExecutor class that orchestrates the execution
of scenario tests, managing the interaction between user simulators, agents under test,
and judge agents to determine test success or failure.
"""

import sys
from typing import (
    Awaitable,
    Callable,
    Dict,
    List,
    Any,
    Optional,
    Set,
    Tuple,
    Union,
)
import time
import termcolor
import asyncio
import concurrent.futures

from scenario.config import ScenarioConfig
from scenario.utils import (
    await_if_awaitable,
    check_valid_return_type,
    convert_agent_return_types_to_openai_messages,
    print_openai_messages,
    show_spinner,
)
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionUserMessageParam,
)

from .types import AgentInput, AgentRole, ScenarioResult, ScriptStep
from .error_messages import agent_response_not_awaitable
from .cache import context_scenario
from .agent_adapter import AgentAdapter
from .script import proceed
from pksuid import PKSUID
from .scenario_state import ScenarioState


class ScenarioExecutor:
    """
    Core orchestrator for scenario-based agent testing.

    The ScenarioExecutor manages the complete lifecycle of a scenario test, including:
    - Orchestrating conversations between user simulators, agents, and judges
    - Managing turn-based execution flow
    - Handling script-based scenario control
    - Collecting and reporting test results
    - Supporting debug mode for interactive testing

    This class serves as both a builder (for configuration) and an executor (for running tests).
    Most users will interact with it through the high-level `scenario.run()` function rather
    than instantiating it directly.

    Attributes:
        name: Human-readable name for the scenario
        description: Detailed description of what the scenario tests
        agents: List of agent adapters participating in the scenario
        script: Optional list of script steps to control scenario flow
        config: Configuration settings for execution behavior

    Example:
        ```python
        # Direct instantiation (less common)
        executor = ScenarioExecutor(
            name="weather query test",
            description="User asks about weather, agent should provide helpful response",
            agents=[
                weather_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides helpful weather info"])
            ],
            max_turns=10,
            verbose=True
        )
        result = await executor._run()

        # Preferred high-level API
        result = await scenario.run(
            name="weather query test",
            description="User asks about weather, agent should provide helpful response",
            agents=[
                weather_agent,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Agent provides helpful weather info"])
            ]
        )
        ```

    Note:
        - Scenarios run in isolated thread pools to support parallel execution
        - All agent interactions are cached when cache_key is configured
        - Debug mode allows step-by-step execution with user intervention
        - Results include detailed timing information and conversation history
    """
    name: str
    description: str
    agents: List[AgentAdapter]
    script: List[ScriptStep]

    config: ScenarioConfig

    _state: ScenarioState
    _total_start_time: float
    _pending_messages: Dict[int, List[ChatCompletionMessageParam]]

    _pending_roles_on_turn: List[AgentRole] = []
    _pending_agents_on_turn: Set[AgentAdapter] = set()
    _agent_times: Dict[int, float] = {}

    def __init__(
        self,
        name: str,
        description: str,
        agents: List[AgentAdapter] = [],
        script: Optional[List[ScriptStep]] = None,
        # Config
        max_turns: Optional[int] = None,
        verbose: Optional[Union[bool, int]] = None,
        cache_key: Optional[str] = None,
        debug: Optional[bool] = None,
    ):
        """
        Initialize a scenario executor.

        Args:
            name: Human-readable name for the scenario (used in reports and logs)
            description: Detailed description of what the scenario tests.
                        This guides the user simulator's behavior and provides context.
            agents: List of agent adapters participating in the scenario.
                   Typically includes: agent under test, user simulator, and judge.
            script: Optional list of script steps to control scenario flow.
                   If not provided, defaults to automatic proceeding.
            max_turns: Maximum number of conversation turns before timeout.
                      Overrides global configuration for this scenario.
            verbose: Whether to show detailed output during execution.
                    Can be True/False or integer level (2 for extra details).
            cache_key: Cache key for deterministic behavior across runs.
                      Overrides global configuration for this scenario.
            debug: Whether to enable debug mode with step-by-step execution.
                  Overrides global configuration for this scenario.

        Example:
            ```python
            executor = ScenarioExecutor(
                name="customer service test",
                description="Customer has a billing question and needs help",
                agents=[
                    customer_service_agent,
                    scenario.UserSimulatorAgent(),
                    scenario.JudgeAgent(criteria=[
                        "Agent is polite and professional",
                        "Agent addresses the billing question",
                        "Agent provides clear next steps"
                    ])
                ],
                max_turns=15,
                verbose=True,
                debug=False
            )
            ```
        """
        self.name = name
        self.description = description
        self.agents = agents
        self.script = script or [proceed()]

        config = ScenarioConfig(
            max_turns=max_turns,
            verbose=verbose,
            cache_key=cache_key,
            debug=debug,
        )
        self.config = (ScenarioConfig.default_config or ScenarioConfig()).merge(config)

        self.reset()

    @classmethod
    async def run(
        cls,
        name: str,
        description: str,
        agents: List[AgentAdapter] = [],
        max_turns: Optional[int] = None,
        verbose: Optional[Union[bool, int]] = None,
        cache_key: Optional[str] = None,
        debug: Optional[bool] = None,
        script: Optional[List[ScriptStep]] = None,
    ) -> ScenarioResult:
        """
        High-level interface for running a scenario test.

        This is the main entry point for executing scenario tests. It creates a
        ScenarioExecutor instance and runs it in an isolated thread pool to support
        parallel execution and prevent blocking.

        Args:
            name: Human-readable name for the scenario
            description: Detailed description of what the scenario tests
            agents: List of agent adapters (agent under test, user simulator, judge)
            max_turns: Maximum conversation turns before timeout (default: 10)
            verbose: Show detailed output during execution
            cache_key: Cache key for deterministic behavior
            debug: Enable debug mode for step-by-step execution
            script: Optional script steps to control scenario flow

        Returns:
            ScenarioResult containing the test outcome, conversation history,
            success/failure status, and detailed reasoning

        Example:
            ```python
            import scenario

            # Simple scenario with automatic flow
            result = await scenario.run(
                name="help request",
                description="User asks for help with a technical problem",
                agents=[
                    my_agent,
                    scenario.UserSimulatorAgent(),
                    scenario.JudgeAgent(criteria=["Agent provides helpful response"])
                ]
            )

            # Scripted scenario with custom evaluations
            result = await scenario.run(
                name="custom interaction",
                description="Test specific conversation flow",
                agents=[
                    my_agent,
                    scenario.UserSimulatorAgent(),
                    scenario.JudgeAgent(criteria=["Agent provides helpful response"])
                ],
                script=[
                    scenario.user("Hello"),
                    scenario.agent(),
                    custom_eval,
                    scenario.succeed()
                ]
            )

            # Results analysis
            print(f"Test {'PASSED' if result.success else 'FAILED'}")
            print(f"Reasoning: {result.reasoning}")
            print(f"Conversation had {len(result.messages)} messages")
            ```

        Note:
            - Runs in isolated thread pool to support parallel execution
            - Blocks until scenario completes or times out
            - All agent calls are automatically cached when cache_key is set
            - Exception handling ensures clean resource cleanup
        """
        scenario = cls(
            name=name,
            description=description,
            agents=agents,
            max_turns=max_turns,
            verbose=verbose,
            cache_key=cache_key,
            debug=debug,
            script=script,
        )

        # We'll use a thread pool to run the execution logic, we
        # require a separate thread because even though asyncio is
        # being used throughout, any user code on the callback can
        # be blocking, preventing them from running scenarios in parallel
        with concurrent.futures.ThreadPoolExecutor() as executor:

            def run_in_thread():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

                try:
                    return loop.run_until_complete(scenario._run())
                finally:
                    loop.close()

            # Run the function in the thread pool and await its result
            # This converts the thread's execution into a Future that the current
            # event loop can await without blocking
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(executor, run_in_thread)
            return result

    def reset(self):
        """
        Reset the scenario executor to initial state.

        This method reinitializes all internal state for a fresh scenario run,
        including conversation history, turn counters, and agent timing information.
        Called automatically during initialization and can be used to rerun scenarios.

        Example:
            ```python
            executor = ScenarioExecutor(...)

            # Run first test
            result1 = await executor._run()

            # Reset and run again
            executor.reset()
            result2 = await executor._run()
            ```
        """
        self._state = ScenarioState(
            description=self.description,
            messages=[],
            thread_id=str(PKSUID("thread")),
            current_turn=0,
            config=self.config,
            _executor=self,
        )
        # Pydantic doesn't actually set the _executor field from the constructor, as it's private, so we need to do it manually
        self._state._executor = self

        self._pending_messages = {}
        self._total_start_time = time.time()
        self._agent_times = {}

        self._new_turn()
        self._state.current_turn = 0

        context_scenario.set(self)

    def add_message(
        self, message: ChatCompletionMessageParam, from_agent_idx: Optional[int] = None
    ):
        """
        Add a message to the conversation and broadcast to other agents.

        This method adds a message to the conversation history and makes it available
        to other agents in their next call. It's used internally by the executor
        and can be called from script steps to inject custom messages.

        Args:
            message: OpenAI-compatible message to add to the conversation
            from_agent_idx: Index of the agent that generated this message.
                           Used to avoid broadcasting the message back to its creator.

        Example:
            ```python
            def inject_system_message(state: ScenarioState) -> None:
                state._executor.add_message({
                    "role": "system",
                    "content": "The user is now in a hurry"
                })

            # Use in script
            result = await scenario.run(
                name="system message test",
                agents=[agent, user_sim, judge],
                script=[
                    scenario.user("Hello"),
                    scenario.agent(),
                    inject_system_message,
                    scenario.user(),  # Will see the system message
                    scenario.succeed()
                ]
            )
            ```
        """
        self._state.messages.append(message)

        # Broadcast the message to other agents
        for idx, _ in enumerate(self.agents):
            if idx == from_agent_idx:
                continue
            if idx not in self._pending_messages:
                self._pending_messages[idx] = []
            self._pending_messages[idx].append(message)

    def add_messages(
        self,
        messages: List[ChatCompletionMessageParam],
        from_agent_idx: Optional[int] = None,
    ):
        """
        Add multiple messages to the conversation.

        Convenience method for adding multiple messages at once. Each message
        is added individually using add_message().

        Args:
            messages: List of OpenAI-compatible messages to add
            from_agent_idx: Index of the agent that generated these messages

        Example:
            ```python
            # Agent returns multiple messages for a complex interaction
            messages = [
                {"role": "assistant", "content": "Let me search for that..."},
                {"role": "assistant", "content": "Here's what I found: ..."}
            ]
            executor.add_messages(messages, from_agent_idx=0)
            ```
        """
        for message in messages:
            self.add_message(message, from_agent_idx)

    def _new_turn(self):
        self._pending_agents_on_turn = set(self.agents)
        self._pending_roles_on_turn = [
            AgentRole.USER,
            AgentRole.AGENT,
            AgentRole.JUDGE,
        ]
        self._state.current_turn += 1

    async def step(self) -> Union[List[ChatCompletionMessageParam], ScenarioResult]:
        """
        Execute a single step in the scenario.

        A step consists of calling the next agent in the current turn's sequence
        and processing their response. This method is used internally by the
        scenario execution flow.

        Returns:
            Either a list of messages (if the scenario continues) or a
            ScenarioResult (if the scenario should end)

        Raises:
            ValueError: If no result is returned from the internal step method

        Note:
            This is primarily an internal method. Most users should use the
            high-level run() method or script DSL functions instead.
        """
        result = await self._step()
        if result is None:
            raise ValueError("No result from step")
        return result

    async def _step(
        self,
        go_to_next_turn=True,
        on_turn: Optional[
            Union[
                Callable[["ScenarioState"], None],
                Callable[["ScenarioState"], Awaitable[None]],
            ]
        ] = None,
    ) -> Union[List[ChatCompletionMessageParam], ScenarioResult, None]:
        if len(self._pending_roles_on_turn) == 0:
            if not go_to_next_turn:
                return None

            self._new_turn()

            if on_turn:
                await await_if_awaitable(on_turn(self._state))

            if self._state.current_turn >= (self.config.max_turns or 10):
                return self._reached_max_turns()

        current_role = self._pending_roles_on_turn[0]
        idx, next_agent = self._next_agent_for_role(current_role)
        if not next_agent:
            self._pending_roles_on_turn.pop(0)
            return await self._step(go_to_next_turn=go_to_next_turn, on_turn=on_turn)

        self._pending_agents_on_turn.remove(next_agent)
        return await self._call_agent(idx, role=current_role)

    def _next_agent_for_role(
        self, role: AgentRole
    ) -> Tuple[int, Optional[AgentAdapter]]:
        for idx, agent in enumerate(self.agents):
            if role == agent.role and agent in self._pending_agents_on_turn:
                return idx, agent
        return -1, None

    def _reached_max_turns(self, error_message: Optional[str] = None) -> ScenarioResult:
        # If we reached max turns without conclusion, fail the test
        agent_roles_agents_idx = [
            idx
            for idx, agent in enumerate(self.agents)
            if agent.role == AgentRole.AGENT
        ]
        agent_times = [
            self._agent_times[idx]
            for idx in agent_roles_agents_idx
            if idx in self._agent_times
        ]
        agent_time = sum(agent_times)

        return ScenarioResult(
            success=False,
            messages=self._state.messages,
            reasoning=error_message
            or f"Reached maximum turns ({self.config.max_turns or 10}) without conclusion",
            total_time=time.time() - self._total_start_time,
            agent_time=agent_time,
        )

    async def _run(self) -> ScenarioResult:
        """
        Run a scenario against the agent under test.

        Args:
            context: Optional initial context for the agent

        Returns:
            ScenarioResult containing the test outcome
        """

        if self.config.verbose:
            print("")  # new line

        self.reset()

        for script_step in self.script:
            callable = script_step(self._state)
            if isinstance(callable, Awaitable):
                result = await callable
            else:
                result = callable

            if isinstance(result, ScenarioResult):
                return result

        return self._reached_max_turns(
            """Reached end of script without conclusion, add one of the following to the end of the script:

- `scenario.proceed()` to let the simulation continue to play out
- `scenario.judge()` to force criteria judgement
- `scenario.succeed()` or `scenario.fail()` to end the test with an explicit result
            """
        )

    async def _call_agent(
        self, idx: int, role: AgentRole, request_judgment: bool = False
    ) -> Union[List[ChatCompletionMessageParam], ScenarioResult]:
        agent = self.agents[idx]

        if role == AgentRole.USER and self.config.debug:
            print(
                f"\n{self._scenario_name()}{termcolor.colored('[Debug Mode]', 'yellow')} Press enter to continue or type a message to send"
            )
            input_message = input(
                self._scenario_name() + termcolor.colored("User: ", "green")
            )

            # Clear the input prompt lines completely
            for _ in range(3):
                sys.stdout.write("\033[F")  # Move up to the input line
                sys.stdout.write("\033[2K")  # Clear the entire input line
            sys.stdout.flush()  # Make sure the clearing is visible

            if input_message:
                return [
                    ChatCompletionUserMessageParam(role="user", content=input_message)
                ]

        with show_spinner(
            text=(
                "Judging..."
                if role == AgentRole.JUDGE
                else f"{role.value if isinstance(role, AgentRole) else role}:"
            ),
            color=(
                "blue"
                if role == AgentRole.AGENT
                else "green" if role == AgentRole.USER else "yellow"
            ),
            enabled=self.config.verbose,
        ):
            start_time = time.time()

            agent_response = agent.call(
                AgentInput(
                    # TODO: test thread_id
                    thread_id=self._state.thread_id,
                    messages=self._state.messages,
                    new_messages=self._pending_messages.get(idx, []),
                    judgment_request=request_judgment,
                    scenario_state=self._state,
                )
            )
            if not isinstance(agent_response, Awaitable):
                raise Exception(
                    agent_response_not_awaitable(agent.__class__.__name__),
                )

            agent_response = await agent_response

            if idx not in self._agent_times:
                self._agent_times[idx] = 0
            self._agent_times[idx] += time.time() - start_time

            self._pending_messages[idx] = []
            check_valid_return_type(agent_response, agent.__class__.__name__)

            messages = []
            if isinstance(agent_response, ScenarioResult):
                # TODO: should be an event
                return agent_response
            else:
                messages = convert_agent_return_types_to_openai_messages(
                    agent_response,
                    role="user" if role == AgentRole.USER else "assistant",
                )

            self.add_messages(messages, from_agent_idx=idx)

            if messages and self.config.verbose:
                print_openai_messages(
                    self._scenario_name(),
                    [m for m in messages if m["role"] != "system"],
                )

            return messages

    def _scenario_name(self):
        if self.config.verbose == 2:
            return termcolor.colored(f"[Scenario: {self.name}] ", "yellow")
        else:
            return ""

    # Scripting utils

    async def message(self, message: ChatCompletionMessageParam) -> None:
        if message["role"] == "user":
            await self._script_call_agent(AgentRole.USER, message)
        elif message["role"] == "assistant":
            await self._script_call_agent(AgentRole.AGENT, message)
        else:
            self.add_message(message)

    async def user(
        self, content: Optional[Union[str, ChatCompletionMessageParam]] = None
    ) -> None:
        await self._script_call_agent(AgentRole.USER, content)

    async def agent(
        self, content: Optional[Union[str, ChatCompletionMessageParam]] = None
    ) -> None:
        await self._script_call_agent(AgentRole.AGENT, content)

    async def judge(
        self, content: Optional[Union[str, ChatCompletionMessageParam]] = None
    ) -> Optional[ScenarioResult]:
        return await self._script_call_agent(
            AgentRole.JUDGE, content, request_judgment=True
        )

    async def proceed(
        self,
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
    ) -> Optional[ScenarioResult]:
        initial_turn: Optional[int] = None
        while True:
            next_message = await self._step(
                on_turn=on_turn,
                go_to_next_turn=(
                    turns is None
                    or initial_turn is None
                    or (self._state.current_turn + 1 < initial_turn + turns)
                ),
            )

            if initial_turn is None:
                initial_turn = self._state.current_turn

            if next_message is None:
                break

            if on_step:
                await await_if_awaitable(on_step(self._state))

            if isinstance(next_message, ScenarioResult):
                return next_message

    async def succeed(self, reasoning: Optional[str] = None) -> ScenarioResult:
        return ScenarioResult(
            success=True,
            messages=self._state.messages,
            reasoning=reasoning
            or "Scenario marked as successful with scenario.succeed()",
        )

    async def fail(self, reasoning: Optional[str] = None) -> ScenarioResult:
        return ScenarioResult(
            success=False,
            messages=self._state.messages,
            reasoning=reasoning or "Scenario marked as failed with scenario.fail()",
        )

    async def _script_call_agent(
        self,
        role: AgentRole,
        content: Optional[Union[str, ChatCompletionMessageParam]] = None,
        request_judgment: bool = False,
    ) -> Optional[ScenarioResult]:
        idx, next_agent = self._next_agent_for_role(role)
        if not next_agent:
            self._new_turn()
            idx, next_agent = self._next_agent_for_role(role)

            if not next_agent:
                role_class = (
                    "a scenario.UserSimulatorAgent()"
                    if role == AgentRole.USER
                    else (
                        "a scenario.JudgeAgent()"
                        if role == AgentRole.JUDGE
                        else "your agent"
                    )
                )
                if content:
                    raise ValueError(
                        f"Cannot generate a message for role `{role.value}` with content `{content}` because no agent with this role was found, please add {role_class} to the scenario `agents` list"
                    )
                raise ValueError(
                    f"Cannot generate a message for role `{role.value}` because no agent with this role was found, please add {role_class} to the scenario `agents` list"
                )

        self._pending_agents_on_turn.remove(next_agent)
        self._pending_roles_on_turn.remove(role)

        if content:
            if isinstance(content, str):
                message = ChatCompletionUserMessageParam(role="user", content=content)
            else:
                message = content

            self.add_message(message)
            if self.config.verbose:
                print_openai_messages(self._scenario_name(), [message])
            return

        result = await self._call_agent(
            idx, role=role, request_judgment=request_judgment
        )
        if isinstance(result, ScenarioResult):
            return result
