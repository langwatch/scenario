"""
Resolves evaluator input mappings against the state of a finished run: the
conversation, the scenario definition and the spans of the trace.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

from opentelemetry.sdk.trace import ReadableSpan

from scenario.evaluators import EvaluatorMapping

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


@dataclass
class EvaluatorInputContext:
    """Everything an input can read from."""

    messages: Sequence[Any]
    description: str
    criteria: List[str] = field(default_factory=list)
    fields: Dict[str, Any] = field(default_factory=dict)
    spans: List[ReadableSpan] = field(default_factory=list)


@dataclass(frozen=True)
class ResolvedValue:
    value: Any


@dataclass(frozen=True)
class ResolvedSkipped:
    reason: str


@dataclass(frozen=True)
class ResolvedFailed:
    """A trace source found nothing; the runner may fetch the remote trace and retry."""

    reason: str


ResolvedInput = Union[ResolvedValue, ResolvedSkipped, ResolvedFailed]


def stringify(value: Any) -> str:
    """Renders a resolved value for the ``inputs`` of an evaluation result."""
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


def _first_user_message(messages: Sequence[Any]) -> str:
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "user":
            return message_text(message)
    return ""


def _last_agent_message(messages: Sequence[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            return message_text(message)
    return ""


def _transcript(messages: Sequence[Any]) -> str:
    return "\n".join(
        f"{message.get('role') if isinstance(message, dict) else 'unknown'}: {message_text(message)}"
        for message in messages
    )


@dataclass(frozen=True)
class _ToolCallRecord:
    name: str
    input: Any
    output: Any


def _parse_arguments(arguments: Any) -> Any:
    if isinstance(arguments, str):
        try:
            return json.loads(arguments)
        except (TypeError, ValueError):
            return arguments
    return arguments


def _message_tool_calls(messages: Sequence[Any]) -> List[_ToolCallRecord]:
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
                )
            )
    return calls


def _attribute(span: ReadableSpan, keys: Sequence[str]) -> Any:
    attributes = span.attributes or {}
    for key in keys:
        value = attributes.get(key)
        if value is not None:
            return value
    return None


def _span_tool_calls(spans: Sequence[ReadableSpan]) -> List[_ToolCallRecord]:
    """Tool spans of the trace, in start order."""
    calls: List[_ToolCallRecord] = []
    for span in spans:
        if _attribute(span, _SPAN_TYPE_ATTRIBUTES) != _TOOL_SPAN_TYPE:
            continue
        calls.append(
            _ToolCallRecord(
                name=str(_attribute(span, _TOOL_NAME_ATTRIBUTES) or span.name),
                input=_attribute(span, _INPUT_ATTRIBUTES),
                output=_attribute(span, _OUTPUT_ATTRIBUTES),
            )
        )
    return calls


def _span_contexts(spans: Sequence[ReadableSpan]) -> List[str]:
    """The retrieved contexts of every rag span, concatenated."""
    contexts: List[str] = []
    for span in spans:
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


def _resolve_tool_call(
    *, tool_name: str, part: str, context: EvaluatorInputContext
) -> ResolvedInput:
    calls = [
        call
        for call in [*_message_tool_calls(context.messages), *_span_tool_calls(context.spans)]
        if call.name == tool_name
    ]
    if not calls:
        return ResolvedFailed(reason=f"no {tool_name} call in the trace")
    call = calls[-1]
    return ResolvedValue(value=call.output if part == "output" else call.input)


def resolve_input(*, mapping: EvaluatorMapping, context: EvaluatorInputContext) -> ResolvedInput:
    """
    Resolves one mapping. A blank field skips the evaluator; a tool call or
    contexts missing from the trace fail it.
    """
    if mapping.type == "value":
        return ResolvedValue(value=mapping.value)

    head = mapping.path[0] if mapping.path else ""
    rest = mapping.path[1:]
    if mapping.source_id == "conversation":
        if head == "first_user_message":
            return ResolvedValue(value=_first_user_message(context.messages))
        if head == "last_agent_message":
            return ResolvedValue(value=_last_agent_message(context.messages))
        if head == "transcript":
            return ResolvedValue(value=_transcript(context.messages))
        if head == "messages":
            return ResolvedValue(value=list(context.messages))
    elif mapping.source_id == "scenario":
        if head == "situation":
            return ResolvedValue(value=context.description)
        if head == "criteria":
            return ResolvedValue(value="\n".join(context.criteria))
        if head == "fields":
            name = rest[0] if rest else ""
            field_value = context.fields.get(name)
            if field_value is None or field_value == "":
                return ResolvedSkipped(reason=f"no {name} on this scenario")
            return ResolvedValue(value=field_value)
    elif mapping.source_id == "trace":
        if head == "contexts":
            contexts = _span_contexts(context.spans)
            if not contexts:
                return ResolvedFailed(reason="no retrieved contexts in the trace")
            return ResolvedValue(value=contexts)
        if head == "tool_calls":
            return _resolve_tool_call(
                tool_name=rest[0] if rest else "",
                part=rest[1] if len(rest) > 1 else "input",
                context=context,
            )
    return ResolvedSkipped(
        reason=f"unknown mapping {mapping.source_id}.{'.'.join(mapping.path)}"
    )


def reads_trace(mapping: EvaluatorMapping) -> bool:
    """True when the mapping reads the trace, so a remote fetch can help it."""
    return mapping.type == "source" and mapping.source_id == "trace"


def distinct_message_trace_ids(messages: Sequence[Any]) -> List[str]:
    """
    All distinct trace ids stamped on the conversation's messages, in
    first-seen order.
    """
    seen: List[str] = []
    for message in messages:
        trace_id = message.get("trace_id") if isinstance(message, dict) else None
        if isinstance(trace_id, str) and trace_id and trace_id not in seen:
            seen.append(trace_id)
    return seen


def last_message_trace_id(messages: Sequence[Any]) -> Optional[str]:
    """The trace id of the last turn, so the evaluation lands on that trace."""
    trace_ids = distinct_message_trace_ids(messages)
    return trace_ids[-1] if trace_ids else None
