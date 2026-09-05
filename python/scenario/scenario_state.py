"""
Scenario state management module.

This module provides the ScenarioState class which tracks the current state
of a scenario execution, including conversation history, turn tracking, and
utility methods for inspecting the conversation.
"""

from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCallParam,
    ChatCompletionUserMessageParam,
)
from opentelemetry.sdk.trace import ReadableSpan
from pydantic import BaseModel, PrivateAttr

from scenario.types import ChatCompletionMessageParamWithTrace
from scenario.config import ScenarioConfig
from scenario._state_views import (
    StateReads,
    StateViewSource,
    ToolCalls,
    TraceView,
    TurnView,
    message_text,
    run_contexts,
    run_tool_calls,
    run_traces,
    run_turns,
    sort_spans,
    transcript,
)

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
        fields: The values the scenario carries next to its description
        criteria: The judge criteria of the scenario
        contexts: Every chunk the agent retrieved, from the rag spans
        spans: Every span of every trace of the run collected so far
        traces: One entry per trace id the messages carry
        turns: One entry per turn, with the messages added during it

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
    messages: List[ChatCompletionMessageParamWithTrace]
    thread_id: str
    current_turn: int
    config: ScenarioConfig

    _executor: "ScenarioExecutor"
    _message_turns: Dict[int, int] = PrivateAttr(default_factory=dict)
    _reads: Optional[StateReads] = PrivateAttr(default=None)
    _span_provider: Optional[Callable[[], List[ReadableSpan]]] = PrivateAttr(default=None)

    def _executor_attr(self, name: str, default: Any) -> Any:
        executor = getattr(self, "_executor", None)
        return getattr(executor, name, default) if executor is not None else default

    def record_turn(self, message: Any) -> None:
        """Records the turn a message was added in, for ``turns`` and tool call turns."""
        self._message_turns[id(message)] = self.current_turn

    def set_span_provider(self, provider: Callable[[], List[ReadableSpan]]) -> None:
        """
        Sets where ``spans`` reads from. Without one, the state reads the
        judge span collector for its thread. Reading never fetches remote
        traces.
        """
        self._span_provider = provider

    def _collected_spans(self) -> List[ReadableSpan]:
        provider = self._span_provider
        if provider is not None:
            return list(provider())
        from ._tracing import judge_span_collector

        return judge_span_collector.get_spans_for_thread(self.thread_id)

    def start_read_tracking(self) -> None:
        """
        Starts recording what the next reads touch, so the evaluator runner
        knows whether a mapping read the trace and what it found missing.
        """
        self._reads = StateReads()

    def take_reads(self) -> StateReads:
        """Stops recording and returns what was read since tracking started."""
        reads = self._reads or StateReads()
        self._reads = None
        return reads

    def note_trace(self) -> None:
        if self._reads is not None:
            self._reads.trace = True

    def note_missing_tool_call(self, name: str) -> None:
        if self._reads is not None and name not in self._reads.missing_tool_calls:
            self._reads.missing_tool_calls.append(name)

    def note_empty_contexts(self) -> None:
        if self._reads is not None:
            self._reads.empty_contexts = True

    def _view_source(self) -> StateViewSource:
        return StateViewSource(
            messages=self.messages,
            spans=self._collected_spans(),
            turn_stamps=self._message_turns,
            reporter=self,
        )

    @property
    def fields(self) -> Dict[str, Any]:
        """The fields the scenario carries next to its description, its data row."""
        return dict(self._executor_attr("fields", {}) or {})

    def field(self, name: str) -> Any:
        """
        One field of the scenario. ``None`` when the scenario does not set it
        or leaves it blank; ``0`` and ``False`` are values.
        """
        value = self.fields.get(name)
        if value is None or value == "":
            if self._reads is not None and name not in self._reads.blank_fields:
                self._reads.blank_fields.append(name)
            return None
        return value

    @property
    def criteria(self) -> List[str]:
        """The judge criteria of the scenario, in order."""
        from .judge_agent import JudgeAgent

        return [
            criterion
            for agent in self._executor_attr("agents", []) or []
            if isinstance(agent, JudgeAgent)
            for criterion in (agent.criteria or [])
        ]

    def first_user_message(self) -> str:
        """The text of the first message the simulated user sent, or an empty string."""
        for message in self.messages:
            if message["role"] == "user":
                return message_text(message)
        return ""

    def last_agent_message(self) -> str:
        """The text of the last message the agent under test sent, or an empty string."""
        for message in reversed(self.messages):
            if message["role"] == "assistant":
                return message_text(message)
        return ""

    def transcript(self) -> str:
        """The conversation so far as one ``role: content`` line per message."""
        return transcript(self.messages)

    def tool_calls(self, name: Optional[str] = None) -> ToolCalls:
        """
        Every call of a tool across the run so far, in start order, merged
        from the tool calls of the assistant messages and the tool spans of
        the traces. ``tool_calls("run_sql").last.input`` is the arguments of
        the last call; when the tool was never called, ``last`` is an empty,
        falsy call whose input and output are ``None``. Without a name,
        every tool call of the run.

        Example:
            ```
            def check_sql(state: ScenarioState) -> None:
                calls = state.tool_calls("run_sql")
                assert calls.last.input["sql"].startswith("SELECT")
                assert len(calls) == 1
            ```
        """
        return run_tool_calls(self._view_source(), name)

    @property
    def contexts(self) -> List[str]:
        """Every chunk the agent retrieved across the run so far, from the rag spans."""
        return run_contexts(self._view_source())

    @property
    def spans(self) -> List[ReadableSpan]:
        """
        Every span of every trace of the run collected so far, in start
        order. Never fetches: a script step reads what the collector holds.
        """
        self.note_trace()
        return sort_spans(self._collected_spans())

    @property
    def traces(self) -> List[TraceView]:
        """One entry per trace id the messages carry, in first-seen order."""
        return run_traces(self._view_source())

    @property
    def turns(self) -> List[TurnView]:
        """One entry per turn, with the messages added during it."""
        return run_turns(self._view_source())

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

    def rollback_messages_to(self, index: int) -> list:
        """Remove all messages from position `index` onward.

        Delegates to the executor to ensure pending queues are cleaned up
        and trace metadata is recorded.

        Args:
            index: Truncate point (clamped to ``[0, len(messages)]``).

        Returns:
            The removed messages.

        Raises:
            ValueError: If *index* is negative.
        """
        return self._executor.rollback_messages_to(index)

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
                    if "function" in tool_call and tool_call["function"]["name"] == tool_name:
                        return tool_call  # type: ignore[return-value]
        return None

    def set_effects(self, effects: List[Callable[[bytes], bytes]]) -> None:
        """
        Replace audio effects on every ``UserSimulatorAgent`` in the scenario.

        Enables the ``proceed(on_turn=...)`` pattern for effects that vary
        during a conversation (proposal §4.5 L548-557):

        ```python
        scenario.proceed(
            turns=3,
            on_turn=lambda s: s.set_effects(
                [effects.background_noise("cafe", volume=0.1 * s.current_turn)]
            ),
        )
        ```

        The mutation takes effect on the *next* user turn. Agents other than
        user simulators (adapters, judges) are ignored.
        """
        from .user_simulator_agent import UserSimulatorAgent

        for agent in getattr(self._executor, "agents", []) or []:
            if isinstance(agent, UserSimulatorAgent):
                agent.audio_effects = list(effects)

    @property
    def timeline(self) -> List[Any]:
        """
        Voice events (``VoiceEvent``) captured so far during this scenario.

        Enables the Example 6.5 callable-as-script-step pattern: a plain
        Python function dropped into ``script=[...]`` can read
        ``state.timeline`` mid-scenario to assert that preceding voice turns
        produced the expected events (``tool_call``, ``user_interrupt``,
        ``agent_start_speaking``, etc.). Empty for text-only scenarios.

        Returns a snapshot list; mutating it does not affect the executor's
        live timeline.
        """
        events = getattr(self._executor, "_voice_timeline", None)
        return list(events) if events else []

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
