"""
Use the Judge Agent module in Scenario to evaluate conversation quality and LLM reasoning during AI agent testing.

This module provides the JudgeAgent class, which evaluates ongoing conversations
between users and agents to determine if success criteria are met. The judge
makes real-time decisions about whether scenarios should continue or end with
success/failure verdicts.
"""

import json
import logging
import re
from typing import Any, List, Optional, Sequence, cast

import litellm
from litellm import Choices
from litellm.files.main import ModelResponse

from scenario.cache import scenario_cache
from scenario.agent_adapter import AgentAdapter
from scenario.config import ModelConfig, ScenarioConfig

from ._error_messages import agent_not_configured_error_message
from ._judge import JudgeUtils, judge_span_digest_formatter
from ._judge.estimate_tokens import estimate_tokens, DEFAULT_TOKEN_THRESHOLD
from ._judge.trace_tools import expand_trace, grep_trace
from ._tracing import judge_span_collector, JudgeSpanCollector
from .types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult
from .voice._transcribe import transcribe_segments


logger = logging.getLogger("scenario")


_DISCOVERY_TOOL_NAMES = frozenset({"expand_trace", "grep_trace"})


def _stringify_tool_output(output: Any) -> str:
    """Best-effort stringify of a tool result for a plain-text recap."""
    if isinstance(output, str):
        return output
    if isinstance(output, dict):
        value = output.get("value")
        if isinstance(value, str):
            return value
        try:
            return json.dumps(output)
        except (TypeError, ValueError):
            return str(output)
    try:
        return json.dumps(output)
    except (TypeError, ValueError):
        return str(output)


def _collapse_discovery_history(messages: List[dict]) -> List[dict]:
    """
    Rewrites message history so every discovery cycle
    (assistant tool_call for expand_trace/grep_trace → tool result)
    collapses into a single plain-text assistant message recounting what
    the judge called and what came back.

    Required before a forced verdict so we can strip expand_trace /
    grep_trace from the tool set without Anthropic rejecting the call
    for referencing undefined tools, and so the model physically cannot
    emit a discovery tool again.

    If an assistant message mixes discovery and non-discovery tool calls,
    only the discovery calls are collapsed to text; non-discovery calls
    and their corresponding tool results are preserved unchanged.

    Messages without any discovery content pass through unchanged.
    """
    out: List[dict] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        tool_calls = msg.get("tool_calls") if isinstance(msg, dict) else None
        has_discovery_call = (
            msg.get("role") == "assistant"
            and isinstance(tool_calls, list)
            and any(
                tc.get("function", {}).get("name") in _DISCOVERY_TOOL_NAMES
                for tc in tool_calls
            )
        )

        if has_discovery_call:
            assert isinstance(tool_calls, list)
            # Gather ALL consecutive following tool result messages (covers
            # both discovery and non-discovery results).
            result_by_id: dict = {}
            j = i + 1
            while (
                j < len(messages)
                and messages[j].get("role") == "tool"
                and messages[j].get("tool_call_id")
            ):
                result_by_id[messages[j]["tool_call_id"]] = messages[j].get(
                    "content", ""
                )
                j += 1

            discovery_calls = [
                tc for tc in tool_calls
                if tc.get("function", {}).get("name") in _DISCOVERY_TOOL_NAMES
            ]
            non_discovery_calls = [
                tc for tc in tool_calls
                if tc.get("function", {}).get("name") not in _DISCOVERY_TOOL_NAMES
            ]
            discovery_ids = {tc.get("id") for tc in discovery_calls}

            lines: List[str] = []
            leading_text = msg.get("content") or ""
            if leading_text:
                lines.append(str(leading_text))

            for tc in discovery_calls:
                name = tc.get("function", {}).get("name", "unknown_tool")
                raw_args = tc.get("function", {}).get("arguments", "")
                try:
                    parsed = json.loads(raw_args) if raw_args else {}
                    args_str = json.dumps(parsed)
                except (TypeError, ValueError):
                    args_str = str(raw_args)
                body = _stringify_tool_output(result_by_id.get(tc.get("id")))
                lines.append(f"[Called {name} with {args_str}]\n{body}")

            new_msg: dict = {"role": "assistant", "content": "\n\n".join(lines)}
            if non_discovery_calls:
                new_msg["tool_calls"] = non_discovery_calls
            out.append(new_msg)

            # Re-emit tool result messages only for non-discovery calls so
            # their tool references remain valid in the stripped tool set.
            for k in range(i + 1, j):
                result_msg = messages[k]
                if result_msg.get("tool_call_id") not in discovery_ids:
                    out.append(result_msg)

            i = j
            continue

        out.append(msg)
        i += 1

    return out


class JudgeAgent(AgentAdapter):
    """
    Agent that evaluates conversations against success criteria.

    The JudgeAgent watches conversations in real-time and makes decisions about
    whether the agent under test is meeting the specified criteria. It can either
    allow the conversation to continue or end it with a success/failure verdict.

    The judge uses function calling to make structured decisions and provides
    detailed reasoning for its verdicts. It evaluates each criterion independently
    and provides comprehensive feedback about what worked and what didn't.

    Attributes:
        role: Always AgentRole.JUDGE for judge agents
        model: LLM model identifier to use for evaluation
        api_base: Optional base URL where the model is hosted
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for evaluation consistency
        max_tokens: Maximum tokens for judge reasoning
        criteria: List of success criteria to evaluate against
        system_prompt: Custom system prompt to override default judge behavior

    Example:
        ```
        import scenario

        # Basic judge agent with criteria
        judge = scenario.JudgeAgent(
            criteria=[
                "Agent provides helpful responses",
                "Agent asks relevant follow-up questions",
                "Agent does not provide harmful information"
            ]
        )

        # Customized judge with specific model and behavior
        strict_judge = scenario.JudgeAgent(
            model="openai/gpt-4.1-mini",
            criteria=[
                "Code examples are syntactically correct",
                "Explanations are technically accurate",
                "Security best practices are mentioned"
            ],
            temperature=0.0,  # More deterministic evaluation
            system_prompt="You are a strict technical reviewer evaluating code quality."
        )

        # Use in scenario
        result = await scenario.run(
            name="coding assistant test",
            description="User asks for help with Python functions",
            agents=[
                coding_agent,
                scenario.UserSimulatorAgent(),
                judge
            ]
        )

        print(f"Passed criteria: {result.passed_criteria}")
        print(f"Failed criteria: {result.failed_criteria}")
        ```

    Note:
        - Judge agents evaluate conversations continuously, not just at the end
        - They can end scenarios early if clear success/failure conditions are met
        - Provide detailed reasoning for their decisions
        - Support both positive criteria (things that should happen) and negative criteria (things that shouldn't)
    """

    role = AgentRole.JUDGE

    model: str
    api_base: Optional[str]
    api_key: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    criteria: List[str]
    system_prompt: Optional[str]
    _extra_params: dict
    _span_collector: JudgeSpanCollector
    _token_threshold: int
    _max_discovery_steps: int

    def __init__(
        self,
        *,
        criteria: Optional[List[str]] = None,
        model: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
        span_collector: Optional[JudgeSpanCollector] = None,
        token_threshold: int = DEFAULT_TOKEN_THRESHOLD,
        max_discovery_steps: int = 10,
        include_audio: Optional[bool] = None,
        include_timeline: Optional[bool] = None,
        include_traces: Optional[bool] = None,
        **extra_params,
    ):
        """
        Initialize a judge agent with evaluation criteria.

        Args:
            criteria: List of success criteria to evaluate the conversation against.
                     Can include both positive requirements ("Agent provides helpful responses")
                     and negative constraints ("Agent should not provide personal information").
            model: LLM model identifier (e.g., "openai/gpt-4.1-mini").
                   If not provided, uses the default model from global configuration.
            api_base: Optional base URL where the model is hosted. If not provided,
                      uses the base URL from global configuration.
            api_key: API key for the model provider. If not provided,
                     uses the key from global configuration or environment.
            temperature: Sampling temperature for evaluation (0.0-1.0).
                        Lower values (0.0-0.2) recommended for consistent evaluation.
            max_tokens: Maximum number of tokens for judge reasoning and explanations.
            system_prompt: Custom system prompt to override default judge behavior.
                          Use this to create specialized evaluation perspectives.
            span_collector: Optional span collector for telemetry. Defaults to global singleton.
            token_threshold: Estimated token count above which traces switch to
                            structure-only rendering with progressive discovery tools.
                            Defaults to 8192.
            max_discovery_steps: Maximum number of expand/grep tool calls the judge
                                can make before being forced to return a verdict.
                                Defaults to 10.

        Raises:
            Exception: If no model is configured either in parameters or global config

        Example:
            ```
            # Customer service judge
            cs_judge = JudgeAgent(
                criteria=[
                    "Agent replies with the refund policy",
                    "Agent offers next steps for the customer",
                ],
                temperature=0.1
            )

            # Technical accuracy judge
            tech_judge = JudgeAgent(
                criteria=[
                    "Agent adds a code review pointing out the code compilation errors",
                    "Agent adds a code review about the missing security headers"
                ],
                system_prompt="You are a senior software engineer reviewing code for production use."
            )
            ```

        Note:
            Advanced usage: Additional parameters can be passed as keyword arguments
            (e.g., headers, timeout, client) for specialized configurations. These are
            experimental and may not be supported in future versions.
        """
        self.criteria = criteria or []
        self.api_base = api_base
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        self._span_collector = span_collector or judge_span_collector
        self._token_threshold = token_threshold
        self._max_discovery_steps = max_discovery_steps
        # Voice-aware judge behaviour (§4.3). None = auto-detect based on
        # conversation content and judge model capabilities.
        self.include_audio = include_audio
        self.include_timeline = include_timeline
        self.include_traces = include_traces

        if model:
            self.model = model

        if ScenarioConfig.default_config is not None and isinstance(
            ScenarioConfig.default_config.default_model, str
        ):
            self.model = model or ScenarioConfig.default_config.default_model
            self._extra_params = extra_params
        elif ScenarioConfig.default_config is not None and isinstance(
            ScenarioConfig.default_config.default_model, ModelConfig
        ):
            self.model = model or ScenarioConfig.default_config.default_model.model
            self.api_base = (
                api_base or ScenarioConfig.default_config.default_model.api_base
            )
            self.api_key = (
                api_key or ScenarioConfig.default_config.default_model.api_key
            )
            self.temperature = (
                temperature or ScenarioConfig.default_config.default_model.temperature
            )
            self.max_tokens = (
                max_tokens or ScenarioConfig.default_config.default_model.max_tokens
            )
            # Extract extra params from ModelConfig
            config_dict = ScenarioConfig.default_config.default_model.model_dump(
                exclude_none=True
            )
            config_dict.pop("model", None)
            config_dict.pop("api_base", None)
            config_dict.pop("api_key", None)
            config_dict.pop("temperature", None)
            config_dict.pop("max_tokens", None)
            # Merge: config extras < agent extra_params
            self._extra_params = {**config_dict, **extra_params}
        else:
            self._extra_params = extra_params

        if not hasattr(self, "model"):
            raise Exception(agent_not_configured_error_message("JudgeAgent"))

    # --------------------------------------------- voice auto-detection (§4.3)
    # Small single-purpose helpers; kept out of call() to preserve SRP.
    _AUDIO_CAPABLE_MODEL_SUBSTRINGS = ("gpt-4o", "gemini-2.5", "gemini-2.0-flash")

    def _model_supports_audio(self) -> bool:
        m = (self.model or "").lower()
        return any(s in m for s in self._AUDIO_CAPABLE_MODEL_SUBSTRINGS)

    def effective_include_audio(self, conversation_has_audio: bool) -> bool:
        """Resolve include_audio: explicit wins, otherwise auto from model capability."""
        if self.include_audio is not None:
            return self.include_audio and conversation_has_audio
        return conversation_has_audio and self._model_supports_audio()

    def effective_include_timeline(self, conversation_has_audio: bool) -> bool:
        """Default timeline True for voice, False for text — unless explicitly set."""
        if self.include_timeline is not None:
            return self.include_timeline
        return conversation_has_audio

    def effective_include_traces(self, otel_configured: bool) -> bool:
        if self.include_traces is not None:
            return self.include_traces
        return otel_configured

    # --------------------------------- audio-transcription fallback helpers

    @staticmethod
    def _conversation_has_audio(messages: List[Any]) -> bool:
        """Return True if any message content contains an audio part."""
        for msg in messages:
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") in ("input_audio", "audio"):
                        return True
        return False

    @staticmethod
    def _extract_recording(input: AgentInput) -> Any:
        """Return the VoiceRecording from the executor, or None."""
        scenario_state = getattr(input, "scenario_state", None)
        if scenario_state is None:
            return None
        executor = getattr(scenario_state, "_executor", None)
        if executor is None:
            return None
        return getattr(executor, "_voice_recording", None)

    @scenario_cache()
    async def call(
        self,
        input: AgentInput,
    ) -> AgentReturnTypes:
        """
        Evaluate the current conversation state against the configured criteria.

        This method analyzes the conversation history and determines whether the
        scenario should continue or end with a verdict. It uses function calling
        to make structured decisions and provides detailed reasoning.

        Args:
            input: AgentInput containing conversation history and scenario context

        Returns:
            AgentReturnTypes: Either an empty list (continue scenario) or a
                            ScenarioResult (end scenario with verdict)

        Raises:
            Exception: If the judge cannot make a valid decision or if there's an
                      error in the evaluation process

        Note:
            - Returns empty list [] to continue the scenario
            - Returns ScenarioResult to end with success/failure
            - Provides detailed reasoning for all decisions
            - Evaluates each criterion independently
            - Can end scenarios early if clear violation or success is detected
        """

        scenario = input.scenario_state
        effective_criteria = (
            input.judgment_request.criteria
            if input.judgment_request and input.judgment_request.criteria is not None
            else self.criteria
        )

        # Build transcript and traces digest
        # When the judge model can't ingest audio, transcribe agent audio and
        # substitute text so the judge can evaluate the content.
        conversation_has_audio = self._conversation_has_audio(input.messages)
        working_messages = input.messages
        if conversation_has_audio and not self.effective_include_audio(conversation_has_audio):
            recording = self._extract_recording(input)
            if recording is not None:
                await transcribe_segments(recording)
                working_messages = _enrich_messages_with_transcripts(
                    input.messages, recording
                )
        transcript = JudgeUtils.build_transcript_from_messages(working_messages)
        spans = self._span_collector.get_spans_for_thread(input.thread_id)
        digest, is_large_trace = self._build_trace_digest(spans)

        logger.debug(f"OpenTelemetry traces built: {digest[:200]}...")

        extra_context = (
            input.judgment_request.context
            if input.judgment_request and input.judgment_request.context
            else None
        )
        extra_context_section = (
            f"\n<additional_context>\n{extra_context}\n</additional_context>"
            if extra_context
            else ""
        )

        content_for_judge = f"""
<transcript>
{transcript}
</transcript>
<opentelemetry_traces>
{digest}
</opentelemetry_traces>{extra_context_section}
"""

        criteria_str = "\n".join(
            [f"{idx + 1}. {criterion}" for idx, criterion in enumerate(effective_criteria)]
        )

        messages: List[dict] = [
            {
                "role": "system",
                "content": self.system_prompt
                or f"""
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to determine if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to determine if you already have enough information to make a verdict of the scenario below, or if the conversation should continue for longer.
If you do have enough information, use the finish_test tool to determine if all the criteria have been met, if not, use the continue_test tool to let the next step play out.
</goal>

<scenario>
{scenario.description}
</scenario>

<criteria>
{criteria_str}
</criteria>

<rules>
- Be strict, do not let the conversation continue if the agent already broke one of the "do not" or "should not" criterias.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
</rules>
""",
            },
            {"role": "user", "content": content_for_judge},
        ]

        max_turns = input.scenario_state.config.max_turns or 10
        is_last_message = (
            input.scenario_state.current_turn >= max_turns - 1
        )

        if is_last_message:
            messages.append(
                {
                    "role": "user",
                    "content": """
System:

<finish_test>
This is the last message, conversation has reached the maximum number of turns, give your final verdict,
if you don't have enough information to make a verdict, say inconclusive with max turns reached.
</finish_test>
""",
                }
            )

        # Define the tools
        criteria_names = [
            re.sub(
                r"[^a-zA-Z0-9]",
                "_",
                criterion.replace(" ", "_").replace("'", "").lower(),
            )[:70]
            for criterion in effective_criteria
        ]
        tools: List[dict] = [
            {
                "type": "function",
                "function": {
                    "name": "continue_test",
                    "description": "Continue the test with the next step",
                    "strict": True,
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": [],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "finish_test",
                    "description": "Complete the test with a final verdict",
                    "strict": True,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "criteria": {
                                "type": "object",
                                "properties": {
                                    criteria_names[idx]: {
                                        "type": "string",
                                        "enum": ["true", "false", "inconclusive"],
                                        "description": criterion,
                                    }
                                    for idx, criterion in enumerate(effective_criteria)
                                },
                                "required": criteria_names,
                                "additionalProperties": False,
                                "description": "Strict verdict for each criterion",
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Explanation of what the final verdict should be",
                            },
                            "verdict": {
                                "type": "string",
                                "enum": ["success", "failure", "inconclusive"],
                                "description": "The final verdict of the test",
                            },
                        },
                        "required": ["criteria", "reasoning", "verdict"],
                        "additionalProperties": False,
                    },
                },
            },
        ]

        if is_large_trace:
            tools = self._build_progressive_discovery_tools() + tools

        enforce_judgment = input.judgment_request is not None
        has_criteria = len(effective_criteria) > 0

        if enforce_judgment and not has_criteria:
            return ScenarioResult(
                success=False,
                messages=[],
                reasoning="TestingAgent was called as a judge, but it has no criteria to judge against",
            )

        tool_choice: Any = (
            {"type": "function", "function": {"name": "finish_test"}}
            if (is_last_message or enforce_judgment) and has_criteria
            else "required"
        )

        # Multi-step discovery loop for large traces
        if is_large_trace:
            return self._run_discovery_loop(
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                spans=spans,
                effective_criteria=effective_criteria,
                input_messages=input.messages,
            )

        # Standard single-call path for small traces
        response = cast(
            ModelResponse,
            litellm.completion(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                api_key=self.api_key,
                api_base=self.api_base,
                max_tokens=self.max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                **self._extra_params,
            ),
        )

        return self._parse_response(response, effective_criteria, messages, input_messages=input.messages)

    def _build_trace_digest(self, spans: Sequence[Any]) -> tuple[str, bool]:
        """
        Builds the trace digest, choosing between full inline rendering
        and structure-only mode based on estimated token count.

        Args:
            spans: The spans for this thread.

        Returns:
            Tuple of (digest_string, is_large_trace).
        """
        full_digest = judge_span_digest_formatter.format(spans)
        is_large_trace = (
            len(spans) > 0 and estimate_tokens(full_digest) > self._token_threshold
        )

        if is_large_trace:
            digest = (
                judge_span_digest_formatter.format_structure_only(spans)
                + "\n\nUse expand_trace(span_id) to see span details or grep_trace(pattern) to search across spans. Reference spans by the ID shown in brackets."
            )
        else:
            digest = full_digest

        logger.debug(
            "Trace digest built",
            extra={
                "is_large_trace": is_large_trace,
                "estimated_tokens": estimate_tokens(full_digest),
            },
        )

        return digest, is_large_trace

    def _build_progressive_discovery_tools(self) -> List[dict]:
        """
        Builds the expand_trace and grep_trace tool definitions for litellm.

        Returns:
            List of tool definition dicts for litellm function calling.
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": "expand_trace",
                    "description": (
                        "Expand one or more spans to see their full details "
                        "(attributes, events, content). Use the span ID shown "
                        "in brackets in the trace skeleton."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "span_ids": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Span IDs (or 8-char prefixes) to expand",
                            },
                        },
                        "required": ["span_ids"],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "grep_trace",
                    "description": (
                        "Search across all span attributes, events, and content "
                        "for a pattern (case-insensitive). Returns matching spans with context."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "pattern": {
                                "type": "string",
                                "description": "Search pattern (case-insensitive)",
                            },
                        },
                        "required": ["pattern"],
                        "additionalProperties": False,
                    },
                },
            },
        ]

    def _run_discovery_loop(
        self,
        *,
        messages: List[dict],
        tools: List[dict],
        tool_choice: Any,
        spans: Sequence[Any],
        effective_criteria: List[str],
        input_messages: Sequence[Any],
    ) -> AgentReturnTypes:
        """
        Runs the multi-step discovery loop for large traces.

        The judge can call expand_trace/grep_trace tools multiple times before
        reaching a terminal tool (finish_test/continue_test) or hitting the
        max discovery steps limit.

        On intermediate steps, tool_choice is "required" so the judge can freely
        pick expand_trace/grep_trace. On the final step, the original tool_choice
        (which may force finish_test) is applied.

        Args:
            messages: The conversation messages so far.
            tools: The tool definitions.
            tool_choice: The tool choice constraint for the final step.
            spans: The spans for executing expand/grep tools.
            effective_criteria: The criteria to judge against.

        Returns:
            AgentReturnTypes from the terminal tool call.
        """
        terminal_tool_names = {"finish_test", "continue_test"}

        for step in range(self._max_discovery_steps):
            # Use "required" for intermediate steps so the judge can use
            # discovery tools; only apply the forced tool_choice on the
            # last allowed step.
            is_last_step = step == self._max_discovery_steps - 1
            step_tool_choice = tool_choice if is_last_step else "required"

            response = cast(
                ModelResponse,
                litellm.completion(
                    model=self.model,
                    messages=messages,
                    temperature=self.temperature,
                    api_key=self.api_key,
                    api_base=self.api_base,
                    max_tokens=self.max_tokens,
                    tools=tools,
                    tool_choice=step_tool_choice,
                    **self._extra_params,
                ),
            )

            if not hasattr(response, "choices") or len(response.choices) == 0:
                raise Exception(
                    f"Unexpected response format from LLM: {response.__repr__()}"
                )

            message = cast(Choices, response.choices[0]).message
            if not message.tool_calls:
                # No tool calls - try to parse as a response
                return self._parse_response(response, effective_criteria, messages, input_messages=input_messages)

            # Check for terminal tool call
            terminal_call = next(
                (tc for tc in message.tool_calls if tc.function.name in terminal_tool_names),
                None,
            )
            if terminal_call:
                return self._parse_response(response, effective_criteria, messages, input_messages=input_messages)

            # Execute discovery tools and add results to messages
            # Add the assistant message with tool calls
            messages.append({
                "role": "assistant",
                "content": message.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ],
            })

            for tc in message.tool_calls:
                tool_result = self._execute_discovery_tool(tc, spans)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result,
                })

        # Hit max steps - force a verdict with whatever information was gathered
        return self._force_verdict(
            messages=messages,
            tools=tools,
            effective_criteria=effective_criteria,
            input_messages=input_messages,
        )

    def _force_verdict(
        self,
        *,
        messages: List[dict],
        tools: List[dict],
        effective_criteria: List[str],
        input_messages: Sequence[Any],
    ) -> AgentReturnTypes:
        """
        Makes one final LLM call with tool_choice forced to finish_test.

        Hardening (vs. a naive re-invocation with the same tool set):
          - Prior discovery tool_call/tool_result pairs are rewritten in the
            message history as plain-text assistant recaps. This lets us
            drop expand_trace/grep_trace from the tool set without
            Anthropic rejecting the call for referencing undefined tools.
          - Discovery tools are then stripped so the model physically
            cannot emit them, closing the leak path where tool_choice
            wasn't honored and a discovery tool reached _parse_response.
        """
        logger.warning(
            f"Progressive discovery hit max steps ({self._max_discovery_steps}), "
            "forcing verdict"
        )

        rewritten_messages = _collapse_discovery_history(messages)
        rewritten_messages.append({
            "role": "user",
            "content": (
                "You have reached the maximum number of trace exploration steps. "
                "Based on the information you have gathered so far, give your final verdict now."
            ),
        })

        finish_only_tools = [
            t for t in tools
            if t.get("function", {}).get("name") not in _DISCOVERY_TOOL_NAMES
        ]

        forced_response = cast(
            ModelResponse,
            litellm.completion(
                model=self.model,
                messages=rewritten_messages,
                temperature=self.temperature,
                api_key=self.api_key,
                api_base=self.api_base,
                max_tokens=self.max_tokens,
                tools=finish_only_tools,
                tool_choice={"type": "function", "function": {"name": "finish_test"}},
                **self._extra_params,
            ),
        )
        return self._parse_response(
            forced_response, effective_criteria, rewritten_messages, input_messages=input_messages
        )

    def _execute_discovery_tool(self, tool_call: Any, spans: Sequence[Any]) -> str:
        """
        Executes an expand_trace or grep_trace tool call.

        Args:
            tool_call: The tool call from the LLM response.
            spans: The spans to operate on.

        Returns:
            The tool result string.
        """
        try:
            args = json.loads(tool_call.function.arguments)
        except json.JSONDecodeError:
            return f"Error: could not parse arguments: {tool_call.function.arguments}"

        if tool_call.function.name == "expand_trace":
            return expand_trace(
                spans,
                span_ids=args.get("span_ids", []),
            )
        elif tool_call.function.name == "grep_trace":
            return grep_trace(spans, args.get("pattern", ""))
        else:
            return f"Unknown tool: {tool_call.function.name}"

    def _parse_response(
        self,
        response: Any,
        effective_criteria: List[str],
        messages: List[dict],
        *,
        input_messages: Sequence[Any],
    ) -> AgentReturnTypes:
        """
        Parses a litellm response into the appropriate return type.

        Handles finish_test, continue_test, and error cases.

        Args:
            response: The litellm ModelResponse.
            effective_criteria: The criteria to evaluate against.
            messages: The judge's internal LLM messages (system prompt + transcript).
            input_messages: The actual conversation messages to include in ScenarioResult.

        Returns:
            AgentReturnTypes: Either an empty list (continue) or ScenarioResult.
        """
        if not hasattr(response, "choices") or len(response.choices) == 0:
            raise Exception(
                f"Unexpected response format from LLM: {response.__repr__()}"
            )

        message = cast(Choices, response.choices[0]).message

        if not message.tool_calls:
            raise Exception(
                f"Invalid response from judge agent, tool calls not found: {message.__repr__()}"
            )

        # In multi-step mode, find the terminal tool call
        terminal_names = {"finish_test", "continue_test"}
        terminal_call = next(
            (tc for tc in message.tool_calls if tc.function.name in terminal_names),
            None,
        )
        tool_call = terminal_call or message.tool_calls[0]

        if tool_call.function.name == "continue_test":
            return []

        if tool_call.function.name == "finish_test":
            try:
                args = json.loads(tool_call.function.arguments)
                verdict = args.get("verdict", "inconclusive")
                reasoning = args.get("reasoning", "No reasoning provided")
                criteria_verdicts = args.get("criteria", {})

                passed_criteria = [
                    effective_criteria[idx]
                    for idx, criterion in enumerate(criteria_verdicts.values())
                    if criterion == "true"
                ]
                failed_criteria = [
                    effective_criteria[idx]
                    for idx, criterion in enumerate(criteria_verdicts.values())
                    if criterion == "false" or criterion == "inconclusive"
                ]

                return ScenarioResult(
                    success=verdict == "success" and len(failed_criteria) == 0,
                    messages=cast(Any, input_messages),
                    reasoning=reasoning,
                    passed_criteria=passed_criteria,
                    failed_criteria=failed_criteria,
                )
            except json.JSONDecodeError:
                raise Exception(
                    f"Failed to parse tool call arguments from judge agent: {tool_call.function.arguments}"
                )

        if tool_call.function.name in _DISCOVERY_TOOL_NAMES:
            logger.warning(
                f"Discovery tool {tool_call.function.name} leaked past "
                "discovery loop without reaching a terminal verdict"
            )
            return ScenarioResult(
                success=False,
                messages=cast(Any, input_messages),
                reasoning=(
                    "JudgeAgent: trace discovery did not converge on a "
                    "verdict within the step budget"
                ),
                passed_criteria=[],
                failed_criteria=list(effective_criteria),
            )

        raise Exception(
            f"Invalid tool call from judge agent: {tool_call.function.name}"
        )


# --------------------------------------------------------------------- #
# Transcript-enrichment helper — module-level to keep JudgeAgent clean  #
# --------------------------------------------------------------------- #


def _enrich_messages_with_transcripts(
    messages: List[Any],
    recording: Any,
) -> List[Any]:
    """
    Add a transcript text part to each audio-only message (both user AND
    agent), preserving the audio part so the judge still sees ``input_audio``
    evidence in the message.

    Why we don't REPLACE: criteria like "agent and user exchanged real audio
    turns" need the audio block visible to the judge as proof the message
    carried bytes, not just text. Replacing the content (the previous
    behavior) made the message look text-only and the judge correctly
    concluded "the assistant's turns are text-only" — which then failed
    audio-presence criteria.

    Strategy: insert a ``{"type": "text", "text": <transcript>}`` part at the
    front of the content list, leaving the input_audio part in place.
    ``_truncate_base64_media`` later collapses the base64 to a placeholder
    so token cost stays bounded; what survives is the **shape** evidence
    (the audio block) plus the readable transcript.

    Returns a new list — does not mutate input.

    Matching strategy: per-role ordinal — the Nth assistant audio-only
    message maps to the Nth agent segment, and the Nth user audio-only
    message maps to the Nth user segment (each in temporal order). This
    role-scoped matching is important when scenarios interleave turns:
    user/agent counts don't have to match.

    If a segment has no transcript (STT failed / unavailable), the
    corresponding message is left as-is so evaluation degrades gracefully.
    """
    # Gather transcripts per-role in temporal order. Both rails are
    # transcribed by the same provider via ``transcribe_segments`` upstream;
    # this loop just routes the resulting text into the matching message.
    segments = getattr(recording, "segments", []) or []
    sorted_segments = sorted(segments, key=lambda s: s.start_time)
    agent_transcripts = [
        s.transcript
        for s in sorted_segments
        if getattr(s, "speaker", None) == "agent" and s.transcript
    ]
    user_transcripts = [
        s.transcript
        for s in sorted_segments
        if getattr(s, "speaker", None) == "user" and s.transcript
    ]

    enriched: List[Any] = []
    agent_msg_idx = 0  # ordinal counter over assistant audio-only messages
    user_msg_idx = 0  # ordinal counter over user audio-only messages

    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else None
        if role not in ("assistant", "user"):
            enriched.append(msg)
            continue

        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            enriched.append(msg)
            continue

        # Check: does this message have audio but no text?
        has_audio = any(
            isinstance(p, dict) and p.get("type") in ("input_audio", "audio")
            for p in content
        )
        has_text = any(
            isinstance(p, dict) and p.get("type") == "text"
            for p in content
        )

        if has_audio and not has_text:
            if role == "assistant" and agent_msg_idx < len(agent_transcripts):
                transcript_text = agent_transcripts[agent_msg_idx]
                agent_msg_idx += 1
                enriched.append({
                    **msg,
                    "content": [{"type": "text", "text": transcript_text}, *content],
                })
                continue
            if role == "user" and user_msg_idx < len(user_transcripts):
                transcript_text = user_transcripts[user_msg_idx]
                user_msg_idx += 1
                enriched.append({
                    **msg,
                    "content": [{"type": "text", "text": transcript_text}, *content],
                })
                continue
            # No transcript available — consume the ordinal slot anyway so
            # subsequent messages map to the right segment.
            if role == "assistant":
                agent_msg_idx += 1
            else:
                user_msg_idx += 1
        enriched.append(msg)

    return enriched
