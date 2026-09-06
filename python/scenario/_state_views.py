"""
Views the scenario state exposes over the run: the text of messages, the
tool calls merged from the messages and the spans, the retrieved contexts,
and the spans grouped by trace and by turn.

Every view reports what it read to a ``StateReadReporter``, so the evaluator
runner knows when a mapping read the trace and what it missed.
"""

import json
from dataclasses import dataclass, field
from typing import (
    Any,
    Dict,
    Iterator,
    List,
    Literal,
    Optional,
    Protocol,
    Sequence,
    Set,
    Union,
    overload,
)

from opentelemetry.sdk.trace import ReadableSpan

_TOOL_SPAN_TYPE = "tool"
_SPAN_TYPE_ATTRIBUTES = ("langwatch.span.type",)
_TOOL_NAME_ATTRIBUTES = ("gen_ai.tool.name",)
_INPUT_ATTRIBUTES = ("langwatch.input", "gen_ai.tool.call.arguments")
_OUTPUT_ATTRIBUTES = ("langwatch.output", "gen_ai.tool.call.result")
_CONTEXT_ATTRIBUTES = (
    "langwatch.rag_contexts",
    "langwatch.rag.contexts",
    "retrieval.documents",
)


@dataclass(frozen=True)
class ToolCall:
    """
    One call of a tool during the run.

    Attributes:
        name: The tool name.
        input: The arguments of the call.
        output: The result of the call, when known.
        turn: The index of the turn the call belongs to, in ``state.turns``.
        source: ``"message"`` when the call came from an assistant message,
            ``"span"`` when it came from a tool span, ``None`` for the empty
            call ``ToolCalls.first`` and ``ToolCalls.last`` return when the
            tool was never called. The empty call is falsy and its input and
            output are ``None``.
    """

    name: str
    input: Any = None
    output: Any = None
    turn: Optional[int] = None
    source: Optional[Literal["message", "span"]] = None

    def __bool__(self) -> bool:
        return self.source is not None


class StateReadReporter(Protocol):
    """What a view reports about what it read and what it missed."""

    def note_trace(self) -> None:
        pass

    def note_missing_tool_call(self, name: str) -> None:
        pass

    def note_empty_contexts(self) -> None:
        pass


@dataclass
class StateReads:
    """What one mapping read from the state, and what it found missing."""

    #: The mapping read the spans, the traces, the contexts or the tool calls.
    trace: bool = False
    #: Fields the mapping read that the scenario leaves blank.
    blank_fields: List[str] = field(default_factory=list)
    #: Tool names the mapping asked for that no message or span carries.
    missing_tool_calls: List[str] = field(default_factory=list)
    #: The mapping read the contexts and the trace holds none.
    empty_contexts: bool = False


class ToolCalls(Sequence[ToolCall]):
    """
    The calls of one tool during the run, in start order. A sequence with
    the picks ``first`` and ``last`` and the columns ``inputs`` and
    ``outputs``.
    """

    def __init__(self, calls: Sequence[ToolCall], name: Optional[str] = None) -> None:
        self._calls = list(calls)
        self._name = name

    @overload
    def __getitem__(self, index: int) -> ToolCall:
        pass

    @overload
    def __getitem__(self, index: slice) -> Sequence[ToolCall]:
        pass

    def __getitem__(self, index: Union[int, slice]) -> Union[ToolCall, Sequence[ToolCall]]:
        return self._calls[index]

    def __len__(self) -> int:
        return len(self._calls)

    def __iter__(self) -> Iterator[ToolCall]:
        return iter(self._calls)

    def __repr__(self) -> str:
        return f"ToolCalls({self._calls!r})"

    def _empty(self) -> ToolCall:
        return ToolCall(name=self._name or "")

    @property
    def first(self) -> ToolCall:
        """The first call. An empty, falsy call when the tool was never called."""
        return self._calls[0] if self._calls else self._empty()

    @property
    def last(self) -> ToolCall:
        """The last call. An empty, falsy call when the tool was never called."""
        return self._calls[-1] if self._calls else self._empty()

    @property
    def inputs(self) -> List[Any]:
        """The input of every call, in order."""
        return [call.input for call in self._calls]

    @property
    def outputs(self) -> List[Any]:
        """The output of every call, in order."""
        return [call.output for call in self._calls]


def stringify(value: Any) -> str:
    """Renders a value for the ``inputs`` of an evaluation result."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)


def message_text(message: Any) -> str:
    """
    Text of a message: the string content, or the text parts joined. Tool
    calls render as their JSON so a transcript keeps them.
    """
    if not isinstance(message, dict):
        return stringify(message)
    content = message.get("content")
    parts: List[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            else:
                parts.append(stringify(part))
    elif content is not None:
        parts.append(stringify(content))
    for tool_call in message.get("tool_calls") or []:
        parts.append(stringify(tool_call))
    return "\n".join(part for part in parts if part)


def transcript(messages: Sequence[Any]) -> str:
    """The conversation as one ``role: content`` line per message."""
    return "\n".join(
        f"{message.get('role') if isinstance(message, dict) else 'unknown'}: {message_text(message)}"
        for message in messages
    )


def _attribute(span: ReadableSpan, keys: Sequence[str]) -> Any:
    attributes = span.attributes or {}
    for key in keys:
        value = attributes.get(key)
        if value is not None:
            return value
    return None


def span_trace_id(span: ReadableSpan) -> Optional[str]:
    """The trace id of a span as the hex string the messages carry."""
    context = span.get_span_context()
    if context is None:
        return None
    return format(context.trace_id, "032x")


def sort_spans(spans: Sequence[ReadableSpan]) -> List[ReadableSpan]:
    """Spans in start order."""
    return sorted(spans, key=lambda span: span.start_time or 0)


def message_trace_ids(messages: Sequence[Any]) -> List[str]:
    """Distinct trace ids on the messages, in first-seen order."""
    seen: List[str] = []
    for message in messages:
        trace_id = message.get("trace_id") if isinstance(message, dict) else None
        if isinstance(trace_id, str) and trace_id and trace_id not in seen:
            seen.append(trace_id)
    return seen


def span_contexts(spans: Sequence[ReadableSpan]) -> List[str]:
    """The retrieved contexts of every rag span, in start order."""
    contexts: List[str] = []
    for span in sort_spans(spans):
        raw = _attribute(span, _CONTEXT_ATTRIBUTES)
        if raw is None:
            continue
        parsed: Any = raw
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                parsed = raw
        if isinstance(parsed, (list, tuple)):
            for item in parsed:
                if isinstance(item, dict) and "content" in item:
                    contexts.append(stringify(item["content"]))
                else:
                    contexts.append(stringify(item))
        else:
            contexts.append(stringify(parsed))
    return contexts


def _parse_arguments(arguments: Any) -> Any:
    if isinstance(arguments, str):
        try:
            return json.loads(arguments)
        except (TypeError, ValueError):
            return arguments
    return arguments


@dataclass
class _ToolCallRecord:
    name: str
    input: Any
    output: Any
    turn: Optional[int]
    source: Literal["message", "span"]
    trace_id: Optional[str]


def _message_tool_calls(
    messages: Sequence[Any], turn_of_message: Dict[int, int]
) -> List[_ToolCallRecord]:
    """
    Tool calls the agent returned in its messages: every entry of an
    assistant message's ``tool_calls``, joined to the tool message with the
    same call id.
    """
    outputs: Dict[str, Any] = {}
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "tool":
            outputs[str(message.get("tool_call_id"))] = message.get("content")
    calls: List[_ToolCallRecord] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for tool_call in message.get("tool_calls") or []:
            function = tool_call.get("function") if isinstance(tool_call, dict) else None
            if not isinstance(function, dict):
                continue
            calls.append(
                _ToolCallRecord(
                    name=str(function.get("name", "")),
                    input=_parse_arguments(function.get("arguments")),
                    output=outputs.get(str(tool_call.get("id"))),
                    turn=turn_of_message.get(id(message)),
                    source="message",
                    trace_id=message.get("trace_id"),
                )
            )
    return calls


def _span_tool_calls(
    spans: Sequence[ReadableSpan], turn_of_trace: Dict[str, int]
) -> List[_ToolCallRecord]:
    """Tool spans, in start order, each attributed to the turn of its trace."""
    calls: List[_ToolCallRecord] = []
    for span in sort_spans(spans):
        if _attribute(span, _SPAN_TYPE_ATTRIBUTES) != _TOOL_SPAN_TYPE:
            continue
        trace_id = span_trace_id(span)
        calls.append(
            _ToolCallRecord(
                name=str(_attribute(span, _TOOL_NAME_ATTRIBUTES) or span.name),
                input=_attribute(span, _INPUT_ATTRIBUTES),
                output=_attribute(span, _OUTPUT_ATTRIBUTES),
                turn=turn_of_trace.get(trace_id) if trace_id else None,
                source="span",
                trace_id=trace_id,
            )
        )
    return calls


def _canonical(value: Any) -> str:
    if isinstance(value, str):
        try:
            return json.dumps(json.loads(value), sort_keys=True)
        except (TypeError, ValueError):
            return value
    try:
        return json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _same_call(a: _ToolCallRecord, b: _ToolCallRecord) -> bool:
    if a.name != b.name:
        return False
    if a.turn is not None and b.turn is not None and a.turn != b.turn:
        return False
    return _canonical(a.input) == _canonical(b.input)


def turn_of_message_map(messages: Sequence[Any], turn_stamps: Dict[int, int]) -> Dict[int, int]:
    """
    The position in ``state.turns`` of every message, keyed by ``id(message)``,
    from the turn stamps the executor records. A message without a stamp
    joins the turn of the message before it.
    """
    positions: Dict[int, int] = {}
    stamps: List[int] = []
    for message in messages:
        stamp = turn_stamps.get(id(message), stamps[-1] if stamps else 0)
        if stamp not in stamps:
            stamps.append(stamp)
        positions[id(message)] = stamps.index(stamp)
    return positions


def _turn_of_trace_map(messages: Sequence[Any], turn_of_message: Dict[int, int]) -> Dict[str, int]:
    mapping: Dict[str, int] = {}
    for message in messages:
        trace_id = message.get("trace_id") if isinstance(message, dict) else None
        if not isinstance(trace_id, str) or not trace_id or trace_id in mapping:
            continue
        index = turn_of_message.get(id(message))
        if index is not None:
            mapping[trace_id] = index
    return mapping


def merge_tool_calls(
    *,
    messages: Sequence[Any],
    spans: Sequence[ReadableSpan],
    all_messages: Sequence[Any],
    turn_stamps: Dict[int, int],
    name: Optional[str] = None,
) -> List[ToolCall]:
    """
    Merges message tool calls and span tool calls by name, in start order:
    turn by turn, the message calls of a turn before its span calls. A span
    that describes a call the messages already carry is not listed twice; it
    fills in the output when the messages have none. Each message call is
    described by at most one span, so a repeated call with the same
    arguments stays a distinct call.
    """
    turn_of_message = turn_of_message_map(all_messages, turn_stamps)
    turn_of_trace = _turn_of_trace_map(all_messages, turn_of_message)
    merged = _message_tool_calls(messages, turn_of_message)
    described: Set[int] = set()
    for span_call in _span_tool_calls(spans, turn_of_trace):
        twin = next(
            (
                call
                for call in merged
                if call.source == "message" and id(call) not in described and _same_call(call, span_call)
            ),
            None,
        )
        if twin is not None:
            described.add(id(twin))
            if twin.output is None and span_call.output is not None:
                twin.output = span_call.output
            continue
        merged.append(span_call)
    ordered = sorted(
        enumerate(merged),
        key=lambda entry: (
            entry[1].turn if entry[1].turn is not None else float("inf"),
            1 if entry[1].source == "span" else 0,
            entry[0],
        ),
    )
    return [
        ToolCall(name=call.name, input=call.input, output=call.output, turn=call.turn, source=call.source)
        for _, call in ordered
        if name is None or call.name == name
    ]


@dataclass
class StateViewSource:
    """What the trace and turn views read from the state."""

    messages: Sequence[Any]
    spans: Sequence[ReadableSpan]
    turn_stamps: Dict[int, int]
    reporter: StateReadReporter


def _collect_tool_calls(
    source: StateViewSource,
    *,
    messages: Sequence[Any],
    spans: Sequence[ReadableSpan],
    name: Optional[str],
) -> ToolCalls:
    source.reporter.note_trace()
    calls = ToolCalls(
        merge_tool_calls(
            messages=messages,
            spans=spans,
            all_messages=source.messages,
            turn_stamps=source.turn_stamps,
            name=name,
        ),
        name=name,
    )
    if name is not None and len(calls) == 0:
        source.reporter.note_missing_tool_call(name)
    return calls


def run_tool_calls(source: StateViewSource, name: Optional[str] = None) -> ToolCalls:
    """Every tool call of the run, or the calls of one tool."""
    return _collect_tool_calls(source, messages=source.messages, spans=source.spans, name=name)


def run_contexts(source: StateViewSource) -> List[str]:
    """The retrieved contexts of the run."""
    source.reporter.note_trace()
    contexts = span_contexts(source.spans)
    if not contexts:
        source.reporter.note_empty_contexts()
    return contexts


class TraceView:
    """One trace of the run: every span of it and the tool calls it holds."""

    def __init__(self, source: StateViewSource, trace_id: str) -> None:
        self._source = source
        self.id = trace_id
        self._messages = [
            message
            for message in source.messages
            if isinstance(message, dict) and message.get("trace_id") == trace_id
        ]

    def _spans(self) -> List[ReadableSpan]:
        return [span for span in self._source.spans if span_trace_id(span) == self.id]

    @property
    def spans(self) -> List[ReadableSpan]:
        """The spans of the trace collected so far, in start order."""
        self._source.reporter.note_trace()
        return sort_spans(self._spans())

    def tool_calls(self, name: Optional[str] = None) -> ToolCalls:
        """The tool calls of this trace, from its messages and its spans."""
        return _collect_tool_calls(self._source, messages=self._messages, spans=self._spans(), name=name)

    def __repr__(self) -> str:
        return f"TraceView(id={self.id!r})"


class TurnView:
    """One turn of the run: its messages, its trace and the tool calls it holds."""

    def __init__(self, source: StateViewSource, index: int, messages: List[Any]) -> None:
        self._source = source
        self.index = index
        self.messages = messages

    @property
    def trace(self) -> Optional[TraceView]:
        """The trace of the turn, when its messages carry a trace id."""
        trace_ids = message_trace_ids(self.messages)
        return TraceView(self._source, trace_ids[0]) if trace_ids else None

    def tool_calls(self, name: Optional[str] = None) -> ToolCalls:
        """The tool calls of this turn, from its messages and its spans."""
        trace_ids = set(message_trace_ids(self.messages))
        spans = [span for span in self._source.spans if span_trace_id(span) in trace_ids]
        return _collect_tool_calls(self._source, messages=self.messages, spans=spans, name=name)

    def __repr__(self) -> str:
        return f"TurnView(index={self.index}, messages={len(self.messages)})"


def run_traces(source: StateViewSource) -> List[TraceView]:
    """One view per trace id the messages carry, in first-seen order."""
    source.reporter.note_trace()
    return [TraceView(source, trace_id) for trace_id in message_trace_ids(source.messages)]


def run_turns(source: StateViewSource) -> List[TurnView]:
    """One view per turn, from the turn stamps on the messages."""
    turn_of_message = turn_of_message_map(source.messages, source.turn_stamps)
    grouped: Dict[int, List[Any]] = {}
    for message in source.messages:
        grouped.setdefault(turn_of_message.get(id(message), 0), []).append(message)
    return [TurnView(source, index, messages) for index, messages in sorted(grouped.items())]
