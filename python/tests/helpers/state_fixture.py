"""
Builds a scenario state for tests: messages stamped with a turn and a trace
id, fields, judge criteria and the spans the state reads.
"""

from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanContext, TraceFlags

from scenario import JudgeAgent
from scenario.config import ScenarioConfig
from scenario.scenario_state import ScenarioState

TRACE_1 = format(1, "032x")
TRACE_2 = format(2, "032x")

SQL_INPUT = {"sql": "SELECT count(*) FROM chargebacks"}


def span(
    name: str,
    attributes: Dict[str, Any],
    *,
    trace_id: int = 1,
    start_ms: int = 0,
) -> ReadableSpan:
    return ReadableSpan(
        name=name,
        context=SpanContext(
            trace_id=trace_id,
            span_id=(hash((name, start_ms)) & 0xFFFFFFFFFFFFFFFF) or 1,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        ),
        attributes=attributes,
        start_time=start_ms * 1_000_000,
    )


def messages_with_tool_call() -> List[Dict[str, Any]]:
    """A user question, a run_sql tool call with its result, and the answer, all in turn 1."""
    return [
        {"role": "user", "content": "How many chargebacks last quarter?", "trace_id": TRACE_1, "turn": 1},
        {
            "role": "assistant",
            "content": None,
            "trace_id": TRACE_1,
            "turn": 1,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "run_sql", "arguments": '{"sql": "SELECT count(*) FROM chargebacks"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"count": 12}', "trace_id": TRACE_1, "turn": 1},
        {"role": "assistant", "content": "There were 12 chargebacks.", "trace_id": TRACE_1, "turn": 1},
    ]


def state_with(
    *,
    messages: Optional[Sequence[Dict[str, Any]]] = None,
    fields: Optional[Dict[str, Any]] = None,
    criteria: Optional[List[str]] = None,
    spans: Optional[List[ReadableSpan]] = None,
    description: str = "A fraud analyst asks for chargebacks.",
) -> ScenarioState:
    """
    A state over the given messages. A ``turn`` key on a message is the turn
    it was added in and is removed from the message.
    """
    executor = SimpleNamespace(
        fields=dict(fields or {}),
        agents=[JudgeAgent(model="none", criteria=criteria or [])],
    )
    state = ScenarioState(
        description=description,
        messages=[],
        thread_id="thread-1",
        current_turn=0,
        config=ScenarioConfig(),
        _executor=executor,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[assignment]
    state.set_span_provider(lambda: list(spans or []))
    for message in messages or []:
        message = dict(message)
        turn = message.pop("turn", 1)
        state.current_turn = turn
        state.messages.append(message)  # type: ignore[arg-type]
        state.record_turn(message)
    return state
