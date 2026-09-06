"""
Resolves one evaluator mapping against the scenario state: calls the mapping
with the state, awaits it, and reports what it read and what it found
missing.
"""

from dataclasses import dataclass
from typing import Any, List, Optional, Sequence, Union

from scenario._state_views import StateReads
from scenario._utils.utils import await_if_awaitable
from scenario.scenario_state import ScenarioState


@dataclass(frozen=True)
class ResolvedValue:
    value: Any


@dataclass(frozen=True)
class ResolvedNothing:
    """
    The mapping found nothing. ``reason`` is what the evaluator reports
    instead of running; ``read_trace`` says the mapping read the trace, so
    the runner may fetch the remote traces and call it again.
    """

    reason: str
    read_trace: bool


@dataclass(frozen=True)
class ResolvedError:
    """The mapping raised."""

    error: Exception


ResolvedInput = Union[ResolvedValue, ResolvedNothing, ResolvedError]


def is_nothing(value: Any) -> bool:
    """True for the values a mapping returns to say it found nothing."""
    return value is None or (isinstance(value, (list, tuple)) and len(value) == 0)


def _reason_for(reads: StateReads) -> str:
    if reads.blank_fields:
        return f"no {reads.blank_fields[0]} on this scenario"
    if reads.missing_tool_calls:
        return f"no {reads.missing_tool_calls[0]} call in the trace"
    if reads.empty_contexts:
        return "no retrieved contexts in the trace"
    return "the mapping returned nothing"


async def resolve_mapping(*, mapping: Any, state: ScenarioState) -> ResolvedInput:
    """Calls the mapping with the state. A literal resolves to itself."""
    if not callable(mapping):
        return ResolvedValue(value=mapping)
    state.start_read_tracking()
    try:
        value = await await_if_awaitable(mapping(state))
    except Exception as error:
        state.take_reads()
        return ResolvedError(error=error)
    reads = state.take_reads()
    if is_nothing(value):
        return ResolvedNothing(reason=_reason_for(reads), read_trace=reads.trace)
    return ResolvedValue(value=value)


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
