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
    Optional,
    Set,
    Tuple,
    Union,
    TypedDict,
)
import time
import warnings
import termcolor
import asyncio
import concurrent.futures

from scenario.config import ScenarioConfig
from scenario._utils import (
    convert_agent_return_types_to_openai_messages,
    check_valid_return_type,
    print_openai_messages,
    show_spinner,
    await_if_awaitable,
    get_batch_run_id,
    generate_scenario_run_id,
)
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionAssistantMessageParam,
)

from .types import AgentInput, AgentRole, ScenarioResult, ScriptStep
from ._error_messages import agent_response_not_awaitable
from .cache import context_scenario
from .agent_adapter import AgentAdapter
from .script import proceed
from pksuid import PKSUID
from .scenario_state import ScenarioState
from ._events import (
    ScenarioEventBus,
    ScenarioEvent,
    ScenarioRunStartedEvent,
    ScenarioMessageSnapshotEvent,
    ScenarioRunFinishedEvent,
    ScenarioRunStartedEventMetadata,
    ScenarioRunFinishedEventResults,
    ScenarioRunFinishedEventVerdict,
    ScenarioRunFinishedEventStatus,
    convert_messages_to_api_client_messages,
)
from rx.subject.subject import Subject
from rx.core.observable.observable import Observable


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
    _events: Subject

    event_bus: ScenarioEventBus

    batch_run_id: str
    scenario_set_id: str

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
        event_bus: Optional[ScenarioEventBus] = None,
        set_id: Optional[str] = None,
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
            event_bus: Optional event bus that will subscribe to this executor's events
            set_id: Optional set identifier for grouping related scenarios
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

        # Create executor's own event stream
        self._events = Subject()

        # Create and configure event bus to subscribe to our events
        self.event_bus = event_bus or ScenarioEventBus()
        self.event_bus.subscribe_to_events(self._events)

        self.batch_run_id = get_batch_run_id()
        self.scenario_set_id = set_id or "default"

    @property
    def events(self) -> Observable:
        """Expose event stream for subscribers like the event bus."""
        return self._events

    def _emit_event(self, event: ScenarioEvent) -> None:
        """
        Emit a domain event to all subscribers.

        This method publishes scenario events to the internal event stream,
        which subscribers (like the event bus) can observe and react to.
        The timestamp is automatically set to the current time.

        Args:
            event: The scenario event to emit
        """
        event.timestamp = int(time.time() * 1000)
        self._events.on_next(event)

    def reset(self):
        """
        Reset the scenario executor to initial state.

        This method reinitializes all internal state for a fresh scenario run,
        including conversation history, turn counters, and agent timing information.
        Called automatically during initialization and can be used to rerun scenarios.
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
            ```
            def inject_system_message(state: ScenarioState) -> None:
                state.add_message({
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
            ```
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
            if (
                role == agent.role
                and agent in self._pending_agents_on_turn
                and agent.role in self._pending_roles_on_turn
            ):
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

    async def run(self) -> ScenarioResult:
        """
        Run a scenario against the agent under test.

        Args:
            context: Optional initial context for the agent

        Returns:
            ScenarioResult containing the test outcome
        """
        scenario_run_id = generate_scenario_run_id()

        try:
            self._emit_run_started_event(scenario_run_id)

            if self.config.verbose:
                print("")  # new line

            self.reset()

            for script_step in self.script:
                callable = script_step(self._state)
                if isinstance(callable, Awaitable):
                    result = await callable
                else:
                    result = callable
                self._emit_message_snapshot_event(scenario_run_id)

                if isinstance(result, ScenarioResult):
                    status = (
                        ScenarioRunFinishedEventStatus.SUCCESS
                        if result.success
                        else ScenarioRunFinishedEventStatus.FAILED
                    )
                    self._emit_run_finished_event(scenario_run_id, result, status)
                    return result

            result = self._reached_max_turns(
                """Reached end of script without conclusion, add one of the following to the end of the script:

- `scenario.proceed()` to let the simulation continue to play out
- `scenario.judge()` to force criteria judgement
- `scenario.succeed()` or `scenario.fail()` to end the test with an explicit result
                """
            )

            status = (
                ScenarioRunFinishedEventStatus.SUCCESS
                if result.success
                else ScenarioRunFinishedEventStatus.FAILED
            )
            self._emit_run_finished_event(scenario_run_id, result, status)
            return result

        except Exception as e:
            # Publish failure event before propagating the error
            error_result = ScenarioResult(
                success=False,
                messages=self._state.messages,
                reasoning=f"Scenario failed with error: {str(e)}",
                total_time=time.time() - self._total_start_time,
                agent_time=0,
            )
            self._emit_run_finished_event(
                scenario_run_id, error_result, ScenarioRunFinishedEventStatus.ERROR
            )
            raise  # Re-raise the exception after cleanup

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

            # Prevent pydantic validation warnings which should already be disabled
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
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

    def _consume_until_role(self, role: AgentRole) -> None:
        while len(self._pending_roles_on_turn) > 0:
            next_role = self._pending_roles_on_turn[0]
            if next_role == role:
                break
            self._pending_roles_on_turn.pop(0)

    async def _script_call_agent(
        self,
        role: AgentRole,
        content: Optional[Union[str, ChatCompletionMessageParam]] = None,
        request_judgment: bool = False,
    ) -> Optional[ScenarioResult]:
        self._consume_until_role(role)
        idx, next_agent = self._next_agent_for_role(role)
        if not next_agent:
            self._new_turn()
            self._consume_until_role(role)
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

        if content:
            if isinstance(content, str):
                message = (
                    ChatCompletionUserMessageParam(role="user", content=content)
                    if role == AgentRole.USER
                    else ChatCompletionAssistantMessageParam(
                        role="assistant", content=content
                    )
                )
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

    # Event handling methods

    class _CommonEventFields(TypedDict):
        """
        Common fields shared across all scenario events.

        These fields provide consistent identification and timing information
        for all events emitted during scenario execution.

        Attributes:
            batch_run_id: Unique identifier for the batch of scenario runs
            scenario_run_id: Unique identifier for this specific scenario run
            scenario_id: Human-readable name/identifier for the scenario
            scenario_set_id: Set identifier for grouping related scenarios
            timestamp: Unix timestamp in milliseconds when the event occurred
        """

        batch_run_id: str
        scenario_run_id: str
        scenario_id: str
        scenario_set_id: str
        timestamp: int

    def _create_common_event_fields(self, scenario_run_id: str) -> _CommonEventFields:
        """
        Create common fields used across all scenario events.

        This method generates the standard fields that every scenario event
        must include for proper identification and timing.

        Args:
            scenario_run_id: Unique identifier for the current scenario run

        Returns:
            Dictionary containing common event fields with current timestamp
        """
        return {
            "batch_run_id": self.batch_run_id,
            "scenario_run_id": scenario_run_id,
            "scenario_id": self.name,
            "scenario_set_id": self.scenario_set_id,
            "timestamp": int(time.time() * 1000),
        }

    def _emit_run_started_event(self, scenario_run_id: str) -> None:
        """
        Emit a scenario run started event.

        This event is published when a scenario begins execution. It includes
        metadata about the scenario such as name and description, and is used
        to track the start of scenario runs in monitoring systems.

        Args:
            scenario_run_id: Unique identifier for the current scenario run
        """
        common_fields = self._create_common_event_fields(scenario_run_id)
        metadata = ScenarioRunStartedEventMetadata(
            name=self.name,
            description=self.description,
        )

        event = ScenarioRunStartedEvent(
            **common_fields,
            metadata=metadata,
        )
        self._emit_event(event)

    def _emit_message_snapshot_event(self, scenario_run_id: str) -> None:
        """
        Emit a message snapshot event.

        This event captures the current state of the conversation during
        scenario execution. It's published whenever messages are added to
        the conversation, allowing real-time tracking of scenario progress.
        """
        common_fields = self._create_common_event_fields(scenario_run_id)

        event = ScenarioMessageSnapshotEvent(
            **common_fields,
            messages=convert_messages_to_api_client_messages(self._state.messages),
        )
        self._emit_event(event)

    def _emit_run_finished_event(
        self,
        scenario_run_id: str,
        result: ScenarioResult,
        status: ScenarioRunFinishedEventStatus,
    ) -> None:
        """
        Emit a scenario run finished event.

        This event is published when a scenario completes execution, whether
        successfully or with an error. It includes the final results, verdict,
        and reasoning for the scenario outcome.

        Args:
            scenario_run_id: Unique identifier for the current scenario run
            result: The final scenario result containing success/failure status
            status: The execution status (SUCCESS, FAILED, or ERROR)
        """
        common_fields = self._create_common_event_fields(scenario_run_id)

        results = ScenarioRunFinishedEventResults(
            verdict=(
                ScenarioRunFinishedEventVerdict.SUCCESS
                if result.success
                else ScenarioRunFinishedEventVerdict.FAILURE
            ),
            reasoning=result.reasoning or "",
            met_criteria=result.passed_criteria,
            unmet_criteria=result.failed_criteria,
        )

        event = ScenarioRunFinishedEvent(
            **common_fields,
            status=status,
            results=results,
        )
        self._emit_event(event)

        # Signal end of event stream
        self._events.on_completed()


async def run(
    name: str,
    description: str,
    agents: List[AgentAdapter] = [],
    max_turns: Optional[int] = None,
    verbose: Optional[Union[bool, int]] = None,
    cache_key: Optional[str] = None,
    debug: Optional[bool] = None,
    script: Optional[List[ScriptStep]] = None,
    set_id: Optional[str] = None,
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
        set_id: Optional set identifier for grouping related scenarios

    Returns:
        ScenarioResult containing the test outcome, conversation history,
        success/failure status, and detailed reasoning

    Example:
        ```
        import scenario

        # Simple scenario with automatic flow
        result = await scenario.run(
           name="help request",
           description="User asks for help with a technical problem",
           agents=[
               my_agent,
               scenario.UserSimulatorAgent(),
               scenario.JudgeAgent(criteria=["Agent provides helpful response"])
           ],
           set_id="customer-support-tests"
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
           ],
           set_id="integration-tests"
        )

        # Results analysis
        print(f"Test {'PASSED' if result.success else 'FAILED'}")
        print(f"Reasoning: {result.reasoning}")
        print(f"Conversation had {len(result.messages)} messages")
        ```
    """
    scenario = ScenarioExecutor(
        name=name,
        description=description,
        agents=agents,
        max_turns=max_turns,
        verbose=verbose,
        cache_key=cache_key,
        debug=debug,
        script=script,
        set_id=set_id,
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
                return loop.run_until_complete(scenario.run())
            finally:
                scenario.event_bus.drain()
                loop.close()

        # Run the function in the thread pool and await its result
        # This converts the thread's execution into a Future that the current
        # event loop can await without blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(executor, run_in_thread)
        return result
