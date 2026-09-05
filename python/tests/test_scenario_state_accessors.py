"""
Ref: specs/scenario-state-accessors.feature

The scenario state exposes the fields, the criteria, the conversation text,
the tool calls merged from messages and spans, the contexts, the spans, and
the spans grouped by trace and by turn.
"""

import json

from scenario.scenario_state import ScenarioState
from tests.helpers.state_fixture import (
    SQL_INPUT,
    TRACE_1,
    TRACE_2,
    messages_with_tool_call,
    span,
    state_with,
)

SECOND_CALL_SPAN = span(
    "run_sql",
    {"langwatch.span.type": "tool", "langwatch.input": '{"sql":"SELECT 1"}', "langwatch.output": "[[1]]"},
    trace_id=1,
    start_ms=200,
)


class TestFields:
    """Scenario: The state exposes the scenario fields."""

    def test_fields_and_field_by_name(self):
        state = state_with(fields={"golden_sql": "SELECT 1", "limit": 0, "strict": False, "blank": ""})
        assert state.fields == {"golden_sql": "SELECT 1", "limit": 0, "strict": False, "blank": ""}
        assert state.field("golden_sql") == "SELECT 1"

    def test_missing_and_blank_fields_are_none(self):
        state = state_with(fields={"blank": ""})
        assert state.field("missing") is None
        assert state.field("blank") is None

    def test_zero_and_false_are_values(self):
        state = state_with(fields={"limit": 0, "strict": False})
        assert state.field("limit") == 0
        assert state.field("strict") is False


class TestCriteria:
    """Scenario: The state exposes the judge criteria."""

    def test_lists_the_criteria_in_order(self):
        state = state_with(criteria=["Reports the count", "Names the quarter"])
        assert state.criteria == ["Reports the count", "Names the quarter"]


class TestConversation:
    """Scenario: The state renders the conversation."""

    def test_first_user_message_last_agent_message_and_transcript(self):
        state = state_with(messages=messages_with_tool_call())
        assert state.first_user_message() == "How many chargebacks last quarter?"
        assert state.last_agent_message() == "There were 12 chargebacks."
        lines = state.transcript().split("\n")
        assert lines[0] == "user: How many chargebacks last quarter?"
        assert "run_sql" in state.transcript()
        assert lines[-1] == "assistant: There were 12 chargebacks."

    def test_empty_conversation_renders_empty_text(self):
        state = state_with()
        assert state.first_user_message() == ""
        assert state.last_agent_message() == ""
        assert state.transcript() == ""


class TestToolCalls:
    """Scenario: Tool calls merge the messages and the spans in start order."""

    def test_lists_message_and_span_calls_in_order(self):
        state = state_with(messages=messages_with_tool_call(), spans=[SECOND_CALL_SPAN])
        calls = state.tool_calls("run_sql")
        assert len(calls) == 2
        assert calls[0].name == "run_sql"
        assert calls[0].input == SQL_INPUT
        assert calls[0].output == '{"count": 12}'
        assert calls[0].turn == 0
        assert calls[0].source == "message"
        assert calls[1].input == '{"sql":"SELECT 1"}'
        assert calls[1].output == "[[1]]"
        assert calls[1].turn == 0
        assert calls[1].source == "span"

    def test_picks_first_and_last_and_lists_inputs_and_outputs(self):
        """Scenario: A tool call collection picks with first and last."""
        state = state_with(messages=messages_with_tool_call(), spans=[SECOND_CALL_SPAN])
        calls = state.tool_calls("run_sql")
        assert calls.first.input == SQL_INPUT
        assert calls.last.input == '{"sql":"SELECT 1"}'
        assert calls.inputs == [SQL_INPUT, '{"sql":"SELECT 1"}']
        assert calls.outputs == ['{"count": 12}', "[[1]]"]
        assert [call.source for call in calls] == ["message", "span"]
        assert calls[-1].source == "span"

    def test_lists_every_tool_call_without_a_name(self):
        state = state_with(messages=messages_with_tool_call(), spans=[SECOND_CALL_SPAN])
        assert [call.name for call in state.tool_calls()] == ["run_sql", "run_sql"]

    def test_a_span_that_describes_a_message_call_is_not_listed_twice(self):
        """Scenario: A span that describes a message tool call is not listed twice."""
        twin = span(
            "run_sql",
            {
                "langwatch.span.type": "tool",
                "gen_ai.tool.name": "run_sql",
                "langwatch.input": json.dumps(SQL_INPUT),
            },
            trace_id=1,
        )
        state = state_with(messages=messages_with_tool_call(), spans=[twin])
        assert len(state.tool_calls("run_sql")) == 1
        assert state.tool_calls("run_sql").first.source == "message"

    def test_an_empty_collection_has_no_pick(self):
        """Scenario: An empty tool call collection has no pick."""
        state = state_with(messages=[{"role": "assistant", "content": "Done."}])
        calls = state.tool_calls("run_sql")
        assert not calls.first
        assert not calls.last
        assert calls.last.input is None
        assert calls.last.output is None
        assert calls.last.name == "run_sql"
        assert calls.inputs == []
        assert calls.outputs == []
        assert len(calls) == 0


class TestSpansAndContexts:
    def test_spans_are_listed_in_start_order(self):
        """Scenario: The state exposes the spans of the run so far."""
        late = span("late", {}, start_ms=300)
        early = span("early", {}, start_ms=100)
        state = state_with(spans=[late, early])
        assert [s.name for s in state.spans] == ["early", "late"]

    def test_contexts_come_from_rag_spans(self):
        """Scenario: The state exposes the retrieved contexts."""
        state = state_with(
            spans=[
                span(
                    "retrieve",
                    {
                        "langwatch.span.type": "rag",
                        "langwatch.rag_contexts": '[{"document_id": "a", "content": "Table chargebacks"}, "plain text"]',
                    },
                )
            ]
        )
        assert state.contexts == ["Table chargebacks", "plain text"]
        assert state_with().contexts == []


class TestTracesAndTurns:
    def _state(self) -> ScenarioState:
        messages = [
            *messages_with_tool_call(),
            {"role": "user", "content": "And per merchant?", "trace_id": TRACE_2, "turn": 2},
            {
                "role": "assistant",
                "content": None,
                "trace_id": TRACE_2,
                "turn": 2,
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "run_sql", "arguments": '{"sql": "SELECT merchant"}'},
                    }
                ],
            },
            {"role": "assistant", "content": "Here they are.", "trace_id": TRACE_2, "turn": 2},
        ]
        spans = [
            span("turn two", {}, trace_id=2, start_ms=500),
            SECOND_CALL_SPAN,
            span("turn one", {}, trace_id=1, start_ms=100),
        ]
        return state_with(messages=messages, spans=spans)

    def test_traces_in_message_order_with_their_spans_and_tool_calls(self):
        """Scenario: The state groups spans by trace."""
        traces = self._state().traces
        assert [trace.id for trace in traces] == [TRACE_1, TRACE_2]
        assert [s.name for s in traces[0].spans] == ["turn one", "run_sql"]
        assert [s.name for s in traces[1].spans] == ["turn two"]
        assert traces[0].tool_calls("run_sql").inputs == [SQL_INPUT, '{"sql":"SELECT 1"}']
        assert traces[1].tool_calls("run_sql").inputs == [{"sql": "SELECT merchant"}]

    def test_turns_with_their_index_messages_trace_and_tool_calls(self):
        """Scenario: The state groups messages by turn."""
        state = self._state()
        turns = state.turns
        assert [turn.index for turn in turns] == [0, 1]
        assert len(turns[0].messages) == 4
        assert len(turns[1].messages) == 3
        assert turns[0].trace is not None and turns[0].trace.id == TRACE_1
        assert turns[1].trace is not None and turns[1].trace.id == TRACE_2
        assert turns[1].tool_calls("run_sql").first.input == {"sql": "SELECT merchant"}
        assert [call.turn for call in state.tool_calls("run_sql")] == [0, 0, 1]
