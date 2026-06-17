"""
Scenario execution engine for agent testing.

This module contains the core ScenarioExecutor class that orchestrates the execution
of scenario tests, managing the interaction between user simulators, agents under test,
and judge agents to determine test success or failure.
"""

import json
import sys
from typing import (
    TYPE_CHECKING,
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Set,
    Tuple,
    Union,
    TypedDict,
    cast,
)

if TYPE_CHECKING:
    from .voice.playback import FfmpegPlayback
import logging
import time
import warnings
import termcolor
import asyncio
import concurrent.futures

logger = logging.getLogger("scenario")

from scenario.config import ScenarioConfig
from langwatch.attributes import AttributeKey
from scenario._utils import (
    convert_agent_return_types_to_openai_messages,
    check_valid_return_type,
    print_openai_messages,
    show_spinner,
    await_if_awaitable,
    get_batch_run_id,
    generate_scenario_run_id,
    SerializableWithStringFallback,
)
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionAssistantMessageParam,
)

from .types import (
    AgentInput,
    AgentRole,
    ChatCompletionMessageParamWithTrace,
    JudgmentRequest,
    ScenarioResult,
    ScriptStep,
)
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

import litellm
import langwatch
import langwatch.telemetry.context
from langwatch.telemetry.tracing import LangWatchTrace


def _extract_text_content(content: object) -> str:
    """Extract a plain-text string from a message content value.

    ``content`` may be a plain string or a list of content-part dicts
    (e.g. ``[{"type": "text", "text": "hello"}, {"type": "image_url", ...}]``).
    Passing a list directly to LangWatch's ``trace.update()`` produces a
    Python repr string (``"[{'type': 'text', ...}]"``), which is unreadable.
    This helper concatenates only the ``"text"`` parts so the trace value is
    always a human-readable string.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return str(content)


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
    _trace: LangWatchTrace
    _ffmpeg_playback: Optional["FfmpegPlayback"] = None

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
        metadata: Optional[Dict[str, Any]] = None,
        on_audio_chunk: Optional[Callable[[Any], None]] = None,
        on_voice_event: Optional[Callable[[Any], None]] = None,
        audio_playback: bool = False,
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
            metadata: Optional metadata to attach to the scenario run.
                     Accepts arbitrary key-value pairs. The ``langwatch`` key
                     is reserved for platform-internal use.
        """
        self.name = name
        self.description = description
        self.agents = agents
        self.script = script or [proceed()]
        self.metadata = metadata
        self._on_audio_chunk = on_audio_chunk
        self._on_voice_event = on_voice_event
        self._audio_playback = audio_playback

        config = ScenarioConfig(
            max_turns=max_turns,
            verbose=verbose,
            cache_key=cache_key,
            debug=debug,
            headless=None,
        )
        self.config = (ScenarioConfig.default_config or ScenarioConfig()).merge(config)

        self.batch_run_id = get_batch_run_id()
        self.scenario_set_id = set_id or "default"
        self._scenario_run_id = generate_scenario_run_id()

        # Create executor's own event stream
        self._events = Subject()

        # Create and configure event bus to subscribe to our events
        self.event_bus = event_bus or ScenarioEventBus()
        self.event_bus.subscribe_to_events(self._events)

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
            thread_id=str(PKSUID("scenariothread")),
            current_turn=0,
            config=self.config,
            _executor=self,
        )
        # Pydantic doesn't actually set the _executor field from the constructor, as it's private, so we need to do it manually
        self._state._executor = self

        self._pending_messages = {}
        self._total_start_time = time.time()
        self._agent_times = {}
        self._checkpoint_results: List[dict] = []

        self._new_turn()
        self._state.current_turn = 0

        context_scenario.set(self)

    @property
    def _compiled_checkpoints(self) -> tuple[List[str], List[str]]:
        """Compile all checkpoint results into aggregated passed/failed criteria."""
        passed: List[str] = []
        failed: List[str] = []
        for cp in self._checkpoint_results:
            passed.extend(cp["passed_criteria"])
            failed.extend(cp["failed_criteria"])
        return passed, failed

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
        message = cast(ChatCompletionMessageParamWithTrace, message)
        message["trace_id"] = self._trace.trace_id
        self._state.messages.append(message)

        # Broadcast the message to other agents
        for idx, _ in enumerate(self.agents):
            if idx == from_agent_idx:
                continue
            if idx not in self._pending_messages:
                self._pending_messages[idx] = []
            self._pending_messages[idx].append(message)

        # Update trace with input/output.
        # Extract text from content (str or list of content parts) so we
        # always pass a str to LangWatch — avoids Python repr of list objects.
        if message["role"] == "user":
            content = message["content"]
            self._trace.update(input=_extract_text_content(content))
        elif message["role"] == "assistant":
            content = (
                message["content"]
                if "content" in message
                else json.dumps(message, cls=SerializableWithStringFallback)
            )
            self._trace.update(output=_extract_text_content(content))

    def rollback_messages_to(self, index: int) -> List[ChatCompletionMessageParam]:
        """Remove all messages from position `index` onward.

        Truncates state.messages and removes matching references from
        _pending_messages queues so no agent sees stale messages.

        .. note::
            This method is safe to call only during an agent's ``call()``
            invocation.  The executor runs agents sequentially, so no
            other agent can observe stale ``new_messages`` references.
            Calling this from outside that flow may leave already-delivered
            ``new_messages`` out of sync.

        Args:
            index: Truncate point.  Messages at positions >= index are
                removed.  Clamped to ``[0, len(messages)]``.

        Returns:
            The removed messages (empty list if nothing to remove).

        Raises:
            ValueError: If *index* is negative.
        """
        if index < 0:
            raise ValueError(
                f"rollback_messages_to: index must be >= 0, got {index}"
            )
        # Clamp to message length — rolling back past the end is a no-op.
        index = min(index, len(self._state.messages))

        removed = list(self._state.messages[index:])
        if not removed:
            return []

        removed_ids = set(id(m) for m in removed)

        del self._state.messages[index:]

        for idx in self._pending_messages:
            self._pending_messages[idx] = [
                m for m in self._pending_messages[idx]
                if id(m) not in removed_ids
            ]

        # Annotate the current trace span so the rollback is visible in
        # tracing dashboards (the removed messages themselves are gone from
        # the conversation, but this event records *that* it happened).
        if hasattr(self, "_trace") and self._trace is not None:
            try:
                self._trace.update(
                    metadata={
                        "scenario.rollback_index": index,
                        "scenario.rollback_removed_count": len(removed),
                    }
                )
            except Exception as exc:
                warnings.warn(
                    f"Failed to update trace metadata during rollback: {exc}",
                    stacklevel=2,
                )

        return cast(List[ChatCompletionMessageParam], removed)

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
        if hasattr(self, "_trace") and self._trace is not None:
            self._trace.__exit__(None, None, None)

        self._trace = langwatch.trace(
            name="Scenario Turn",
            metadata={
                "labels": ["scenario"],
                "thread_id": self._state.thread_id,
                "scenario.name": self.name,
                "scenario.batch_id": self.batch_run_id,
                "scenario.set_id": self.scenario_set_id,
                "scenario.turn": self._state.current_turn,
            },
        ).__enter__()

        if self._trace.root_span is not None:
            self._trace.root_span.set_attributes({
                "langwatch.origin": "simulation",
                "scenario.run_id": self._scenario_run_id,
            })

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
        self._scenario_run_id = scenario_run_id
        _check_failure: Optional[BaseException] = None

        # Connect all voice adapters before script runs; disconnect in finally.
        await self._voice_connect_all()

        try:
            self._emit_run_started_event(scenario_run_id)

            if self.config.verbose:
                print("")  # new line

            self.reset()

            for i, script_step in enumerate(self.script):
                try:
                    callable = script_step(self._state)
                    if isinstance(callable, Awaitable):
                        result = await callable
                    else:
                        result = callable
                except AssertionError as e:
                    _check_failure = e
                    break

                self._emit_message_snapshot_event(scenario_run_id)

                if isinstance(result, ScenarioResult):
                    compiled_passed, _ = self._compiled_checkpoints
                    result.passed_criteria = compiled_passed + result.passed_criteria

                    status = (
                        ScenarioRunFinishedEventStatus.SUCCESS
                        if result.success
                        else ScenarioRunFinishedEventStatus.FAILED
                    )
                    result = self._attach_voice_output(result)
                    self._emit_run_finished_event(scenario_run_id, result, status)
                    return result

            if _check_failure is not None:
                compiled_passed, compiled_failed = self._compiled_checkpoints
                error_result = ScenarioResult(
                    success=False,
                    messages=self._state.messages,
                    reasoning=f"Scenario failed with error: {str(_check_failure)}",
                    passed_criteria=compiled_passed,
                    failed_criteria=compiled_failed + [str(_check_failure)],
                    total_time=time.time() - self._total_start_time,
                    agent_time=0,
                )
                self._emit_run_finished_event(
                    scenario_run_id,
                    error_result,
                    ScenarioRunFinishedEventStatus.ERROR,
                )
                raise _check_failure

            elif self._checkpoint_results:
                compiled_passed, compiled_failed = self._compiled_checkpoints
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

                result = ScenarioResult(
                    success=len(compiled_failed) == 0,
                    messages=self._state.messages,
                    reasoning="All inline criteria checkpoints passed",
                    passed_criteria=compiled_passed,
                    failed_criteria=compiled_failed,
                    total_time=time.time() - self._total_start_time,
                    agent_time=agent_time,
                )
                result = self._attach_voice_output(result)

                status = (
                    ScenarioRunFinishedEventStatus.SUCCESS
                    if result.success
                    else ScenarioRunFinishedEventStatus.FAILED
                )
                self._emit_run_finished_event(scenario_run_id, result, status)
                return result
            else:
                result = self._reached_max_turns(
                    """Reached end of script without conclusion, add one of the following:

- Add `scenario.judge()` to the script to force criteria judgement
- Add `scenario.succeed()` or `scenario.fail()` to end the test with an explicit result
- If your script already has a judge but is hitting max_turns, increase `max_turns` in your config
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
            if _check_failure is not None:
                # Already handled above — just propagate
                raise

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
        finally:
            await self._voice_disconnect_all()

    async def _voice_connect_all(self) -> None:
        """Invoke ``connect()`` on every VoiceAgentAdapter in the scenario."""
        from .voice.adapter import VoiceAgentAdapter
        from .voice.recording import LatencyMetrics, VoiceRecording
        from .voice.playback import FfmpegPlayback

        self._voice_recording: VoiceRecording = VoiceRecording()
        self._voice_timeline: list = []
        self._voice_latency: LatencyMetrics = LatencyMetrics()
        self._voice_recording_started_at: float = time.monotonic()
        self._pending_agent_task = None
        self._ffmpeg_playback = None

        if self._audio_playback:
            player = FfmpegPlayback()
            player.start()
            self._ffmpeg_playback = player
            # Wrap the user-supplied on_audio_chunk so playback coexists with it.
            user_callback = self._on_audio_chunk

            def _playback_and_forward(chunk: Any) -> None:
                player.feed(chunk)
                if user_callback is not None:
                    user_callback(chunk)

            self._on_audio_chunk = _playback_and_forward

        for agent in self.agents:
            if isinstance(agent, VoiceAgentAdapter):
                await agent.connect()

    def _attach_voice_output(self, result: ScenarioResult) -> ScenarioResult:
        """Populate result.audio/timeline/latency if any voice adapter ran."""
        from .voice.adapter import VoiceAgentAdapter

        has_voice = any(isinstance(a, VoiceAgentAdapter) for a in self.agents)
        if not has_voice:
            return result
        recording = getattr(self, "_voice_recording", None)
        timeline = getattr(self, "_voice_timeline", None)
        latency = getattr(self, "_voice_latency", None)
        if recording is not None and recording.segments:
            result.audio = recording
            # Pin the timeline onto the recording too so save_segments() can
            # write events into the manifest. The result already exposes
            # timeline directly; this just makes it accessible from the
            # recording object for serialisation.
            recording.timeline = list(timeline) if timeline else []
            # Mark agent segments whose span contains a user_interrupt event:
            # the chunk-level transcripts come from the AUT's API and reflect
            # the agent's INTENDED reply, not what actually played to the user
            # before the interrupt cut the audio. Flag these so consumers
            # (manifest readers, judges) know to re-transcribe from bytes.
            interrupts = [e for e in (timeline or []) if e.type == "user_interrupt"]
            for seg in recording.segments:
                if seg.speaker != "agent":
                    continue
                for evt in interrupts:
                    if seg.start_time <= evt.time <= seg.end_time:
                        seg.transcript_truncated = True
                        break
        if timeline:
            result.timeline = list(timeline)
        if latency is not None and latency.measurements:
            result.latency = latency
        return result

    async def _voice_disconnect_all(self) -> None:
        """Invoke ``disconnect()`` on every VoiceAgentAdapter.

        Swallows exceptions so cleanup always completes — disconnect failures
        are logged but do not mask the primary scenario result.
        """
        from .voice.adapter import VoiceAgentAdapter

        for agent in self.agents:
            if not isinstance(agent, VoiceAgentAdapter):
                continue
            try:
                await agent.disconnect()
            except Exception:
                logger.warning(
                    "voice adapter %s disconnect failed",
                    type(agent).__name__,
                    exc_info=True,
                )

        if self._ffmpeg_playback is not None:
            try:
                await asyncio.to_thread(self._ffmpeg_playback.stop)
            except Exception:
                logger.warning(
                    "ffmpeg playback stop failed during voice disconnect",
                    exc_info=True,
                )
            self._ffmpeg_playback = None

    async def _call_agent(
        self, idx: int, role: AgentRole, judgment_request: Optional[JudgmentRequest] = None
    ) -> Union[List[ChatCompletionMessageParam], ScenarioResult, None]:
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

        try:
            with self._trace.span(
                type="agent", name=f"{agent.__class__.__name__}.call"
            ) as span:
                span.set_attributes(
                    {
                        AttributeKey.LangWatchThreadId: self._state.thread_id,
                        "scenario.role": role.value if isinstance(role, AgentRole) else str(role),
                    }
                )
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

                    # Suppress noisy pydantic serializer warnings emitted by
                    # litellm + langwatch tracing when dispatching the
                    # ChatCompletionMessageParam union (developer/system/user/
                    # assistant/tool/function variants). The previous scope
                    # only wrapped the call-coroutine *creation*; the await
                    # below is where litellm.completion actually runs and
                    # where the warnings fire. Keep the await inside.
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")

                        self._trace.autotrack_litellm_calls(litellm)

                        agent_response = agent.call(
                            AgentInput(
                                thread_id=self._state.thread_id,
                                messages=cast(
                                    List[ChatCompletionMessageParam],
                                    self._state.messages,
                                ),
                                new_messages=self._pending_messages.get(idx, []),
                                judgment_request=judgment_request,
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
                    span.add_evaluation(
                        name=f"{agent.__class__.__name__} Judgment",
                        status="processed",
                        passed=agent_response.success,
                        details=agent_response.reasoning,
                        score=(
                            len(agent_response.passed_criteria)
                            / len(agent_response.failed_criteria)
                            if agent_response.failed_criteria
                            else 1.0
                        ),
                    )

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

                # Voice path: if a wait=False (or interrupt-scheduled) agent
                # turn is in flight when the user-sim produces its turn, fire
                # the interrupt sequence so the new audio lands mid-response.
                if role == AgentRole.USER and messages:
                    pending = getattr(self, "_pending_agent_task", None)
                    if pending is not None and not pending.done():
                        await self._fire_user_interrupt(messages[-1])

                return messages
        except Exception as e:
            agent_name = agent.__class__.__name__
            # str(e) is empty for no-args exceptions like asyncio.TimeoutError().
            # Fall back to the exception type name so the error body is never blank.
            error_detail = str(e) or type(e).__name__
            raise RuntimeError(f"[{agent_name}] {error_detail}") from e

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
        self,
        content: Optional[Union[str, ChatCompletionMessageParam]] = None,
        *,
        voice_style: Optional[str] = None,
        audio_effects: Optional[List[Callable[[bytes], bytes]]] = None,
    ) -> None:
        """Invoke the user simulator, optionally with per-step voice overrides.

        ``voice_style`` and ``audio_effects`` override the simulator's
        configured defaults for this step only. The simulator restores its
        defaults on the next step — implemented via a context manager on the
        UserSimulatorAgent (``_one_shot_override``).

        When the user-role agent is an ``OpenAIRealtimeAgentAdapter`` and ``content``
        is a plain string, route through the realtime session's text-input
        channel instead of TTS (per §7.2 L1164-1171).
        """
        if isinstance(content, str):
            realtime_user = self._find_realtime_user_agent()
            if realtime_user is not None:
                # Note: voice_style / audio_effects are no-ops on the realtime
                # text-routing path — the realtime model generates audio
                # natively, not via the simulator's TTS chain. Document + pass.
                await realtime_user.send_text(content)
                self.add_message(
                    {"role": "user", "content": content}  # type: ignore[arg-type]
                )
                return
            # If a voice-capable UserSimulatorAgent exists, TTS the scripted
            # text through it so the agent adapter receives audio rather than
            # a text-only message. Without this, voice agents under test
            # (OpenAIRealtime, ElevenLabs hosted, Pipecat, etc.) see no audio
            # when the scenario script emits `scenario.user("...")`.
            sim = self._find_user_sim()
            if sim is not None and getattr(sim, "voice", None):
                # Apply per-step overrides if supplied — without this, callers
                # using scenario.user("text", voice_style=..., audio_effects=...)
                # would silently have those dropped on the voice-sim branch.
                if voice_style is not None or audio_effects is not None:
                    with sim._one_shot_override(
                        voice_style=voice_style, audio_effects=audio_effects
                    ):
                        voiced = await sim._voiceify(
                            {"role": "user", "content": content}
                        )
                else:
                    voiced = await sim._voiceify(
                        {"role": "user", "content": content}
                    )
                self.add_message(voiced)  # type: ignore[arg-type]
                # Interruption path: when a wait=False agent turn is in flight,
                # this user() call IS the interrupt. ``agent(wait=False) +
                # user(...)`` reads as "agent starts replying; user
                # interrupts" — no sleep needed. ``_fire_user_interrupt``
                # handles the wait-for-speaking → adapter.interrupt() →
                # send_audio → cancel sequence and emits the
                # ``user_interrupt`` timeline event. Shared with the
                # proceed-driven ``interrupt_probability`` path so the two
                # interrupt code paths can't drift.
                pending = getattr(self, "_pending_agent_task", None)
                if pending is not None and not pending.done():
                    await self._fire_user_interrupt(voiced)
                return
        sim = self._find_user_sim()
        if sim is not None and (voice_style is not None or audio_effects is not None):
            with sim._one_shot_override(voice_style=voice_style, audio_effects=audio_effects):
                await self._script_call_agent(AgentRole.USER, content)
        else:
            await self._script_call_agent(AgentRole.USER, content)

    def _find_user_sim(self):
        from .user_simulator_agent import UserSimulatorAgent

        for agent in self.agents:
            if isinstance(agent, UserSimulatorAgent):
                return agent
        return None

    def _find_realtime_user_agent(self):
        """Return an OpenAIRealtimeAgentAdapter configured as role=USER, if any."""
        try:
            from .voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter
        except ImportError:  # pragma: no cover — voice adapters always importable here
            return None
        for agent in self.agents:
            if isinstance(agent, OpenAIRealtimeAgentAdapter) and agent.role == AgentRole.USER:
                return agent
        return None

    def _find_voice_adapter(self):
        """Return the first VoiceAgentAdapter in role=AGENT on the scenario, if any.

        Used by the interruption path: when ``user(text)`` is called while a
        ``wait=False`` agent turn is in flight, we push the synthesised audio
        through this adapter directly so the bot actually hears it on the wire.
        """
        from .voice.adapter import VoiceAgentAdapter

        for agent in self.agents:
            if isinstance(agent, VoiceAgentAdapter):
                return agent
        return None

    @staticmethod
    def _extract_audio_from_message(message):
        """Pull the AudioChunk out of a multi-part user audio message, if present.

        Mirrors ``scenario.voice.messages.extract_audio`` but avoids importing
        it eagerly (it lives in the voice subtree).
        """
        from .voice.messages import extract_audio

        return extract_audio(message)

    def _clear_adapter_pending_messages(self, adapter) -> None:
        """Drop all queued ``new_messages`` for the adapter's idx.

        Called from ``_fire_user_interrupt`` after we hand-deliver the
        user interrupt audio to the adapter directly. Without this clear,
        the recovery agent turn would re-send the original user audio
        (the cancelled background ``_call_agent`` consumed it from
        ``input.new_messages`` but never reached the post-call line that
        empties the queue, so the message stays queued) AND/OR the
        interrupt's user audio (which we already sent by hand). On
        Gemini Live, replaying queued audio causes the SDK to emit
        duplicate activity boundaries and produces garbled recovery.
        """
        try:
            adapter_idx = self.agents.index(adapter)
        except ValueError:
            return
        self._pending_messages[adapter_idx] = []

    def _interrupt_rng(self):
        """Lazy ``random.Random`` instance for sampling interrupt_probability.

        Seeded from ``ScenarioConfig.cache_key`` when present so replay with
        the same cache_key produces the same interruption schedule. When
        cache_key is unset the RNG is unseeded — interruption decisions vary
        between runs, matching the rest of the executor's non-cached path.
        """
        existing = getattr(self, "_interrupt_rng_instance", None)
        if existing is not None:
            return existing
        import random as _random

        seed = getattr(self.config, "cache_key", None)
        rng = _random.Random(seed) if seed else _random.Random()
        self._interrupt_rng_instance = rng
        return rng

    async def _fire_user_interrupt(self, voiced_message) -> None:
        """Mid-stream interrupt: send the transport-native interrupt (if any)
        and push the new user audio IMMEDIATELY — without waiting for the
        agent to start speaking — then cancel the in-flight agent task and
        record a ``user_interrupt`` timeline event.

        The previous version waited for ``_agent_speaking_event`` before
        barging in. That was wrong: if the bot is slow to start (LLM warm-up,
        TTS warm-up), the wait blocks until the agent has nearly finished
        replying, defeating the purpose of barge-in. Real production
        providers (EL ConvAI, Gemini Live, OpenAI Realtime) expect the
        client to push audio whenever the user speaks; their VADs handle
        the rest. Our job is to be PROMPT, not POLITE.

        ``metadata.outcome`` captures what actually happened:
          - ``pending_done``: the agent task already completed before we got
            here — nothing to interrupt
          - ``no_adapter``: there's no voice adapter (text-only path)
          - ``fired_after_speech``: the agent had started speaking when we
            barged in (true mid-stream interrupt — manifest segment for
            this turn will have ``transcript_truncated=True``)
          - ``fired_before_speech``: the agent had not started speaking yet;
            our barge-in landed in the bot's pre-reply window. Still
            counted as ``fired`` from the script's perspective, but the
            manifest will not flag a truncated segment for this turn.

        Time of the event is captured at the START of the sequence so
        cross-referencing with agent segments correctly flags segments
        that were live when the interrupt was intended, not when the
        cancel-sequence finished settling.
        """
        # ``interrupt_time`` is set at the actual barge-in point below —
        # AFTER we wait for the agent to start speaking. Capturing it up
        # front (as the earlier version did) misrepresented the event when
        # the agent was still warming up: the event landed seconds before
        # the agent_start_speaking event the script was trying to truncate
        # (see issue #467).
        anchor = getattr(self, "_voice_recording_started_at", None)
        interrupt_time = (time.monotonic() - anchor) if anchor is not None else 0.0

        pending = getattr(self, "_pending_agent_task", None)
        adapter = self._find_voice_adapter()

        outcome: str
        native_interrupt_fired = False

        if pending is None or pending.done():
            outcome = "pending_done"
        elif adapter is None:
            outcome = "no_adapter"
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, Exception):
                # Drain the cancellation — any exception from the cancelled
                # task is expected and intentional. We're abandoning this
                # agent turn because no adapter is available to barge in on.
                pass
            self._pending_agent_task = None
        else:
            # If the agent hasn't started speaking yet, wait briefly for
            # them to start so the barge-in lands mid-utterance (the whole
            # point of an interrupt). Bounded so a hung bot doesn't stall
            # the script forever — callers using ``scenario.interrupt()``
            # can override via ``wait_for_speech_timeout``.
            speaking = adapter._agent_speaking_event
            if not speaking.is_set():
                try:
                    await asyncio.wait_for(speaking.wait(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Bounded wait: don't stall the script forever if a hung
                    # bot never starts speaking. We proceed and fire the
                    # interrupt anyway — the outcome label will be
                    # "fired_before_speech" so callers can see what happened.
                    pass

            # Snapshot BEFORE we barge in so we can label the outcome
            # accurately. (After we send the user audio, the agent may
            # belatedly emit a frame that races our cancel; that frame
            # should NOT count as "agent was speaking when we interrupted.")
            agent_was_speaking = speaking.is_set()
            outcome = "fired_after_speech" if agent_was_speaking else "fired_before_speech"

            # Refresh interrupt_time so the timeline event lands at the
            # actual barge-in point — inside the agent's speaking window
            # when one exists, or at the give-up moment when the warm-up
            # never produced audio (issue #467).
            interrupt_time = (time.monotonic() - anchor) if anchor is not None else interrupt_time

            # 1. Send native cancel signal first (if supported) — this drops
            #    the bot's buffered outbound audio on transports that honor
            #    it (Twilio ``clear``, OpenAI Realtime ``response.cancel``).
            if adapter.capabilities.interruption:
                try:
                    await adapter.interrupt()
                    native_interrupt_fired = True
                except Exception:
                    # Best-effort native cancel — adapters' interrupt() may
                    # fail mid-flight (WS closed, transport error). Step 2
                    # (push user audio) is the load-bearing barge-in path
                    # and runs regardless; native_interrupt_fired stays
                    # False so the outcome label reflects reality.
                    pass

            # 2. Push user audio — the bot's VAD detects the overlap and
            #    triggers its own barge-in, regardless of whether it had
            #    started speaking. This is what makes the interrupt actually
            #    truncate the reply on adapters without a native cancel
            #    (EL ConvAI, Gemini Live).
            chunk = self._extract_audio_from_message(voiced_message)
            audio_was_sent = False
            if chunk is not None:
                # Capture the user-segment timestamps around the send so
                # the recording's manifest reflects the interrupting turn.
                # Without this, transports like Gemini Live emit a
                # user_interrupt event but no user segment — the recording
                # only shows the original user turn (see issue #466).
                user_start = (time.monotonic() - anchor) if anchor is not None else 0.0
                try:
                    await adapter.send_audio(chunk)
                    audio_was_sent = True
                except Exception:
                    # Best-effort: send_audio may fail if the adapter just
                    # tore down. The interrupt sequence still completes —
                    # audio_was_sent stays False so the cleanup branch
                    # below skips clearing pending messages (which would
                    # otherwise drop the unsent user turn on the floor).
                    pass
                if audio_was_sent:
                    self._record_interrupt_user_segment(chunk, user_start)

            # 3. Cancel scenario-side awaiter and let any in-flight agent
            #    audio drain. The recorder will close out the partial agent
            #    segment with whatever bytes landed before the cancel.
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, Exception):
                # Drain the cancellation — CancelledError is expected; any
                # other exception thrown by the agent task at cancel time
                # is also intentional (we're tearing the turn down). The
                # recorder closes out the partial segment from already-
                # received bytes.
                pass
            self._pending_agent_task = None

            # Mark the interrupt's user audio (and any other queued
            # messages — including the original user turn the cancelled
            # task was processing) as already consumed by this adapter.
            # Without this, the next agent() call (the recovery turn)
            # re-sends queued audio via adapter.call()'s
            # extract-from-new-messages path, which on Gemini Live causes
            # the SDK to emit duplicate activity boundaries and produces
            # an empty/garbled recovery reply.
            if audio_was_sent:
                self._clear_adapter_pending_messages(adapter)

        timeline = getattr(self, "_voice_timeline", None)
        if timeline is not None:
            try:
                from .voice.recording import VoiceEvent

                metadata = {
                    "adapter": type(adapter).__name__ if adapter is not None else None,
                    "native": native_interrupt_fired,
                    "outcome": outcome,
                }
                event = VoiceEvent(
                    time=interrupt_time,
                    type="user_interrupt",
                    metadata=metadata,
                )
                timeline.append(event)
                hook = getattr(self, "_on_voice_event", None)
                if hook is not None:
                    try:
                        hook(event)
                    except Exception:
                        # User-supplied hook — swallow exceptions so a
                        # buggy observer can't break the scenario. The
                        # event is still recorded on the timeline above.
                        pass
            except Exception:
                # Timeline append is observability, not control flow. If
                # construction or recording fails, the scenario should
                # still complete — surfacing here would mask the actual
                # scenario outcome behind a recorder bug.
                pass

    def _record_interrupt_user_segment(self, chunk, user_start: float) -> None:
        """Append a user segment + start/stop events for an interrupt's audio.

        The default ``VoiceAgentAdapter.call`` path records user segments
        via ``_AdapterRecorder.record_user``. ``_fire_user_interrupt``
        calls ``adapter.send_audio`` directly, bypassing that recorder —
        so without this helper, transports like Gemini Live emit a
        ``user_interrupt`` event but no corresponding user segment.

        Both this path and ``_AdapterRecorder.record_user`` delegate to
        the shared ``voice.adapter.write_user_segment`` writer so the
        timing model lives in one place.
        """
        anchor = getattr(self, "_voice_recording_started_at", None)
        user_end = (time.monotonic() - anchor) if anchor is not None else user_start
        try:
            from .voice.adapter import write_user_segment

            write_user_segment(self, chunk, user_start, user_end)
        except Exception:
            # Recording is observability; if append fails the scenario
            # should still run. The interrupt itself already landed via
            # adapter.send_audio above. Log so a buggy recorder is
            # visible in CI/logs rather than silently degrading the
            # manifest — matches the _append_event pattern.
            logger.warning(
                "_record_interrupt_user_segment failed; manifest may "
                "omit the interrupt user turn — interrupt itself fired.",
                exc_info=True,
            )

    async def _maybe_schedule_interrupted_agent_turn(self) -> bool:
        """If a UserSimulatorAgent has ``interrupt_probability > 0`` and the
        next pending role with a still-unconsumed agent is AGENT, sample the
        probability and — when it lands — dispatch the agent turn as a
        background task so the next user-sim turn fires the interrupt path
        mid-response.

        Returns ``True`` if an interruption was scheduled (so the caller can
        skip the normal step for AGENT this iteration).
        """
        # ``_step`` only pops a role from ``_pending_roles_on_turn`` lazily
        # on the call after the role's agent was consumed, so the front of
        # the list can still name a "spent" role. Walk past those to find
        # the next role that will actually run.
        next_role: Optional[AgentRole] = None
        for r in self._pending_roles_on_turn:
            _idx, _agent = self._next_agent_for_role(r)
            if _agent is not None:
                next_role = r
                break
        if next_role != AgentRole.AGENT:
            return False
        sim = self._find_user_sim()
        prob = float(getattr(sim, "interrupt_probability", 0.0) or 0.0) if sim else 0.0
        if prob <= 0.0:
            return False
        if self._find_voice_adapter() is None:
            return False
        pending = getattr(self, "_pending_agent_task", None)
        if pending is not None and not pending.done():
            return False
        if self._interrupt_rng().random() >= prob:
            return False
        idx, agent = self._next_agent_for_role(AgentRole.AGENT)
        if agent is None:
            return False
        self._pending_agents_on_turn.remove(agent)
        # Consume spent roles up to (and including) AGENT so the proceed
        # loop's next ``_step`` call advances to JUDGE / new turn cleanly.
        while self._pending_roles_on_turn and self._pending_roles_on_turn[0] != AgentRole.AGENT:
            self._pending_roles_on_turn.pop(0)
        if self._pending_roles_on_turn and self._pending_roles_on_turn[0] == AgentRole.AGENT:
            self._pending_roles_on_turn.pop(0)
        coro = self._call_agent(idx, role=AgentRole.AGENT)
        self._pending_agent_task = asyncio.create_task(coro)
        return True

    async def agent(
        self,
        content: Optional[Union[str, ChatCompletionMessageParam]] = None,
        *,
        wait: bool = True,
    ) -> None:
        """Run the agent turn.

        When ``wait=False`` (§4.4 L369-382), the agent call is dispatched as
        a background task and control returns immediately. This is the async
        primitive that enables interruption testing: subsequent script steps
        run while the agent is still speaking.

        A background turn is drained at the start of the next blocking step
        (``user()``, ``agent()``, ``judge()``, ``proceed()``, ``succeed()``
        or ``fail()``) so subsequent reads of ``state.messages`` see the
        completed agent message.
        """
        if not wait:
            self._schedule_background_agent_turn(content)
            return
        await self._script_call_agent(AgentRole.AGENT, content)

    def _schedule_background_agent_turn(
        self, content: Optional[Union[str, ChatCompletionMessageParam]]
    ) -> None:
        pending = getattr(self, "_pending_agent_task", None)
        if pending is not None and not pending.done():
            raise RuntimeError(
                "An async agent turn is already in flight — interleave sleep()/user() steps "
                "or call agent() (wait=True) to await it."
            )
        coro = self._script_call_agent(AgentRole.AGENT, content)
        self._pending_agent_task = asyncio.create_task(coro)

    async def _drain_pending_agent_turn(self) -> None:
        pending = getattr(self, "_pending_agent_task", None)
        if pending is None:
            return
        # If _script_call_agent itself is running under the pending background
        # task (the drain centralised at its top re-entered on the background
        # coroutine), awaiting would deadlock with "Task cannot await on
        # itself". Skip the drain in that case — the task is already running.
        current = asyncio.current_task()
        if current is pending:
            return
        try:
            _ = await pending
        finally:
            self._pending_agent_task = None

    async def judge(
        self,
        criteria: Optional[List[str]] = None,
        additional_context: Optional[str] = None,
    ) -> Optional[ScenarioResult]:
        return await self._script_call_agent(
            AgentRole.JUDGE,
            judgment_request=JudgmentRequest(criteria=criteria, additional_context=additional_context),
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
        await self._drain_pending_agent_turn()
        initial_turn: Optional[int] = None
        while True:
            # Voice path: roll UserSimulatorAgent.interrupt_probability against
            # the upcoming AGENT turn. On a hit, the agent turn runs in the
            # background and the next user-sim turn fires the interrupt path
            # mid-response. No-op for text scenarios or when probability is 0.
            await self._maybe_schedule_interrupted_agent_turn()

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
        await self._drain_pending_agent_turn()
        return ScenarioResult(
            success=True,
            messages=self._state.messages,
            reasoning=reasoning
            or "Scenario marked as successful with scenario.succeed()",
        )

    async def fail(self, reasoning: Optional[str] = None) -> ScenarioResult:
        await self._drain_pending_agent_turn()
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
        judgment_request: Optional[JudgmentRequest] = None,
    ) -> Optional[ScenarioResult]:
        # Any blocking script step (user/agent/judge/proceed) must drain a
        # pending wait=False agent turn so later reads of state.messages are
        # consistent. Centralised here to avoid shotgun surgery across every
        # call site.
        await self._drain_pending_agent_turn()
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

        # Gap 1 (AC9/AC10): signal the voice adapter that an agent turn is about
        # to be dispatched. This per-turn flag lets recv_audio fire a bare
        # response.create for agent-initiated turns (no user audio committed) —
        # both the opening turn AND subsequent agent turns in multi-turn scripts.
        # Guards with hasattr so non-realtime adapters are unaffected.
        if role == AgentRole.AGENT:
            _notify = getattr(next_agent, "notify_agent_turn", None)
            if callable(_notify):
                _notify()

        result = await self._call_agent(
            idx, role=role, judgment_request=judgment_request
        )

        if isinstance(result, ScenarioResult):
            if judgment_request is not None and judgment_request.criteria is not None:
                # Checkpoint: record result
                self._checkpoint_results.append({
                    "passed_criteria": result.passed_criteria,
                    "failed_criteria": result.failed_criteria,
                })

                if result.success:
                    # Checkpoint passed: continue script
                    return None
                else:
                    # Checkpoint failed: compile all results into the failing result.
                    compiled_passed, compiled_failed = self._compiled_checkpoints
                    result.passed_criteria = compiled_passed
                    result.failed_criteria = compiled_failed
                    return result
            else:
                # Final judge evaluation — merge prior checkpoint criteria
                compiled_passed, _ = self._compiled_checkpoints
                result.passed_criteria = compiled_passed + result.passed_criteria
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
        if self.metadata:
            for key, value in self.metadata.items():
                if key not in ("name", "description"):
                    metadata.additional_properties[key] = value

        event = ScenarioRunStartedEvent(
            **common_fields,
            metadata=metadata,
        )
        self._emit_event(event)

    def _emit_message_snapshot_event(self, scenario_run_id: str) -> None:
        """
        Emit a message snapshot event.

        This event captures the current state of the conversation during
        scenario execution. It's published after every script step, allowing
        real-time tracking of scenario progress.

        Any failure while building or emitting the snapshot is logged as a
        warning and swallowed so that a telemetry error can never abort an
        otherwise-healthy scenario run.  This guard is intentionally broad:
        the snapshot fires on arbitrary in-flight conversation content (e.g.
        empty-content voice turns) where serialization or transport errors are
        plausible and must be non-fatal.

        Note: _emit_run_started_event and _emit_run_finished_event are NOT
        guarded because they carry structured, schema-controlled data produced
        by the executor itself — not raw, user-supplied message content.
        """
        try:
            common_fields = self._create_common_event_fields(scenario_run_id)

            event = ScenarioMessageSnapshotEvent(
                **common_fields,
                messages=convert_messages_to_api_client_messages(self._state.messages),
            )
            self._emit_event(event)
        except Exception:
            logger.warning(
                "Failed to emit message snapshot event; snapshot skipped",
                exc_info=True,
            )

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
        self._trace.__exit__(None, None, None)


def _build_scenario(
    *,
    name: str,
    description: str,
    agents: List[AgentAdapter],
    max_turns: Optional[int],
    verbose: Optional[Union[bool, int]],
    cache_key: Optional[str],
    debug: Optional[bool],
    script: Optional[List[ScriptStep]],
    set_id: Optional[str],
    metadata: Optional[Dict[str, Any]],
    on_audio_chunk: Optional[Callable[[Any], None]] = None,
    on_voice_event: Optional[Callable[[Any], None]] = None,
    audio_playback: bool = False,
) -> "ScenarioExecutor":
    """Shared setup used by both ``run()`` (threaded) and ``arun()`` (async-native)."""
    from ._tracing import ensure_tracing_initialized

    config = ScenarioConfig.default_config
    ensure_tracing_initialized(config.observability if config else None)

    return ScenarioExecutor(
        name=name,
        description=description,
        agents=agents,
        max_turns=max_turns,
        verbose=verbose,
        cache_key=cache_key,
        debug=debug,
        script=script,
        set_id=set_id,
        metadata=metadata,
        on_audio_chunk=on_audio_chunk,
        on_voice_event=on_voice_event,
        audio_playback=audio_playback,
    )


def _cleanup_scenario_spans(scenario: "ScenarioExecutor") -> None:
    """Clear judge spans for this scenario's thread_id to prevent memory buildup."""
    from ._tracing import judge_span_collector

    if hasattr(scenario, "_state") and scenario._state:
        judge_span_collector.clear_spans_for_thread(scenario._state.thread_id)


async def arun(
    name: str,
    description: str,
    agents: List[AgentAdapter] = [],
    max_turns: Optional[int] = None,
    verbose: Optional[Union[bool, int]] = None,
    cache_key: Optional[str] = None,
    debug: Optional[bool] = None,
    script: Optional[List[ScriptStep]] = None,
    set_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    on_audio_chunk: Optional[Callable[[Any], None]] = None,
    on_voice_event: Optional[Callable[[Any], None]] = None,
    audio_playback: bool = False,
) -> ScenarioResult:
    """Async-native counterpart of :func:`run`.

    Runs the scenario directly on the caller's event loop, so async state
    created on that loop (anything set up in an async fixture, for
    example) stays usable across concurrent scenarios.

    :func:`run` remains the default: it executes each scenario in its own
    worker thread, so sync and async adapters both parallelize with no
    extra work on your side. Reach for ``arun`` only when your codebase
    is fully async-first and your adapter relies on async objects whose
    identity is tied to the loop they were created on. Parallelism is
    then the caller's responsibility, via ``asyncio.gather`` or
    ``pytest-asyncio-concurrent``.

    The signature and return value mirror :func:`run`.
    """
    scenario = _build_scenario(
        name=name,
        description=description,
        agents=agents,
        max_turns=max_turns,
        verbose=verbose,
        cache_key=cache_key,
        debug=debug,
        script=script,
        set_id=set_id,
        metadata=metadata,
        on_audio_chunk=on_audio_chunk,
        on_voice_event=on_voice_event,
        audio_playback=audio_playback,
    )

    try:
        result = await scenario.run()
        _cleanup_scenario_spans(scenario)
        return result
    finally:
        # ``event_bus.drain()`` blocks on ``queue.join()`` while waiting for
        # the event-bus worker thread to finish HTTP posting, so we offload
        # it to avoid stalling the caller's loop.
        await asyncio.to_thread(scenario.event_bus.drain)


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
    metadata: Optional[Dict[str, Any]] = None,
    on_audio_chunk: Optional[Callable[[Any], None]] = None,
    on_voice_event: Optional[Callable[[Any], None]] = None,
    audio_playback: bool = False,
) -> ScenarioResult:
    """
    High-level interface for running a scenario test.

    This is the main entry point for executing scenario tests. It creates a
    ScenarioExecutor instance and runs it in an isolated thread pool to support
    parallel execution and prevent blocking.

    .. note::
        If your :class:`AgentAdapter` awaits on async state that was
        created on the caller's event loop (anything set up in an async
        fixture, for example), use :func:`arun` instead. ``run`` spins up
        a fresh event loop on a worker thread and those objects will raise
        ``"Future attached to a different loop"`` when they are awaited
        from that thread.

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
        metadata: Optional metadata to attach to the scenario run.
                 Accepts arbitrary key-value pairs. The ``langwatch`` key
                 is reserved for platform-internal use.

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
    scenario = _build_scenario(
        name=name,
        description=description,
        agents=agents,
        max_turns=max_turns,
        verbose=verbose,
        cache_key=cache_key,
        debug=debug,
        script=script,
        set_id=set_id,
        metadata=metadata,
        on_audio_chunk=on_audio_chunk,
        on_voice_event=on_voice_event,
        audio_playback=audio_playback,
    )

    # We'll use a thread pool to run the execution logic, we
    # require a separate thread because even though asyncio is
    # being used throughout, any user code on the callback can
    # be blocking, preventing them from running scenarios in parallel.
    #
    # NB: this isolation also spins up a private event loop per run, so
    # adapters that depend on async state bound to the caller's loop must
    # use :func:`arun` instead.
    with concurrent.futures.ThreadPoolExecutor() as executor:

        def run_in_thread():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                result = loop.run_until_complete(scenario.run())
                _cleanup_scenario_spans(scenario)
                return result
            finally:
                scenario.event_bus.drain()
                loop.close()

        # Run the function in the thread pool and await its result
        # This converts the thread's execution into a Future that the current
        # event loop can await without blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(executor, run_in_thread)
        return result
