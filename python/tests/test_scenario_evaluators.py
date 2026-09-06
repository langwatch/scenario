"""
Ref: specs/scenario-evaluators.feature

Evaluators on scenario runs: mappings as functions of the state, inference,
resolution, the gate a required evaluator applies to the run, and the
evaluations on the run events.
"""

from typing import Any, Callable, Dict, List, Optional

import pytest

from scenario import JudgeAgent, UserSimulatorAgent, agent, judge, user
from scenario._evaluators import (
    EvaluatorInput,
    EvaluatorSpec,
    ResolvedError,
    ResolvedNothing,
    ResolvedValue,
    RunEvaluatorsDeps,
    apply_evaluations_to_result,
    infer_evaluator_mappings,
    is_expected_like_input,
    resolve_mapping,
    run_scenario_evaluators,
)
from scenario._events import (
    EventReporter,
    ScenarioEvent,
    ScenarioEventBus,
    ScenarioRunFinishedEvent,
    ScenarioRunStartedEvent,
)
from scenario.agent_adapter import AgentAdapter
from scenario.evaluators import (
    conversation,
    evaluator,
    field,
    scenario_source,
    trace,
    value,
)
from scenario.scenario_executor import ScenarioExecutor
from scenario.scenario_state import ScenarioState
from scenario.types import AgentInput, ScenarioResult
from tests.helpers.state_fixture import (
    SQL_INPUT,
    TRACE_1,
    TRACE_2,
    messages_with_tool_call,
    span,
    state_with,
)

SQL_EQUIVALENCE = EvaluatorSpec(
    evaluator_id="ragas/sql_query_equivalence",
    name="SQL Query Equivalence",
    inputs=[
        EvaluatorInput(id="output", required=True),
        EvaluatorInput(id="expected_output", required=True),
        EvaluatorInput(id="expected_contexts", required=True),
    ],
    produces_passed=True,
)

SCORE_JUDGE = EvaluatorSpec(
    evaluator_id="eval_123",
    name="Answer quality",
    inputs=[EvaluatorInput(id="input", required=False), EvaluatorInput(id="output", required=False)],
    produces_passed=False,
)

FIELDS = {
    "golden_sql": "SELECT count(*) FROM chargebacks",
    "table_schema": "CREATE TABLE chargebacks (...)",
}

SQL_ATTACHMENT = evaluator(
    "ragas/sql_query_equivalence",
    required=True,
    mappings={
        "output": lambda state: state.tool_calls("run_sql").last.input,
        "expected_output": field("golden_sql"),
        "expected_contexts": lambda state: state.field("table_schema"),
    },
)


class _FakeDeps:
    def __init__(
        self,
        specs: Dict[str, EvaluatorSpec],
        response: Optional[Dict[str, Any]] = None,
        error: Optional[Exception] = None,
        fetch_remote_traces: bool = False,
        on_fetch: Optional[Callable[[], None]] = None,
    ) -> None:
        self.specs = specs
        self.response = response or {"status": "processed", "passed": True, "details": "ok"}
        self.error = error
        self.calls: List[Dict[str, Any]] = []
        self.fetches = 0
        self.on_fetch = on_fetch
        self.deps = RunEvaluatorsDeps(
            get_evaluator_spec=self._spec,
            evaluate=self._evaluate,
            fetch_remote_traces=self._fetch if fetch_remote_traces else None,
        )

    async def _spec(self, ref: str) -> Optional[EvaluatorSpec]:
        return self.specs.get(ref)

    async def _evaluate(self, **kwargs: Any) -> Dict[str, Any]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response

    async def _fetch(self) -> None:
        self.fetches += 1
        if self.on_fetch is not None:
            self.on_fetch()


def _full_state(**overrides: Any) -> ScenarioState:
    options: Dict[str, Any] = dict(messages=messages_with_tool_call(), fields=FIELDS)
    options.update(overrides)
    return state_with(**options)


def _judge_success() -> ScenarioResult:
    return ScenarioResult(
        success=True,
        messages=[],
        reasoning="All criteria passed",
        passed_criteria=["Reports the count"],
    )


class TestMappingsAreStateCallables:
    @pytest.mark.asyncio
    async def test_a_mapping_is_a_function_of_the_state(self):
        """Scenario: A mapping is a function of the scenario state."""
        state = _full_state()
        seen: List[Any] = []

        def read(s: ScenarioState) -> Any:
            seen.append(s)
            return s.field("golden_sql")

        resolved = await resolve_mapping(mapping=read, state=state)
        assert seen == [state]
        assert resolved == ResolvedValue(value=FIELDS["golden_sql"])

    @pytest.mark.asyncio
    async def test_an_async_mapping_is_awaited(self):
        """Scenario: An async mapping is awaited."""

        async def read(s: ScenarioState) -> str:
            return s.first_user_message()

        resolved = await resolve_mapping(mapping=read, state=_full_state())
        assert resolved == ResolvedValue(value="How many chargebacks last quarter?")

    @pytest.mark.asyncio
    async def test_a_literal_is_a_constant(self):
        """Scenario: A literal mapping is a constant."""
        state = _full_state()
        assert await resolve_mapping(mapping="en", state=state) == ResolvedValue(value="en")
        assert await resolve_mapping(mapping=3, state=state) == ResolvedValue(value=3)
        assert await resolve_mapping(mapping=False, state=state) == ResolvedValue(value=False)

    @pytest.mark.asyncio
    async def test_a_mapping_that_raises_reports_the_error(self):
        """Scenario: A mapping that raises errors the evaluator."""

        def read(_: ScenarioState) -> Any:
            raise ValueError("boom")

        resolved = await resolve_mapping(mapping=read, state=_full_state())
        assert isinstance(resolved, ResolvedError)
        assert str(resolved.error) == "boom"

    def test_helpers_name_their_expression(self):
        """Scenario: The declarative helpers are state callables."""
        assert conversation.first_user_message.expression == "state.first_user_message() or None"
        assert conversation.last_agent_message.expression == "state.last_agent_message() or None"
        assert field("golden_sql").expression == "state.field('golden_sql')"
        assert trace.tool_calls("run_sql").last.input.expression == "state.tool_calls('run_sql').last.input"
        assert trace.tool_calls("run_sql").first.output.expression == "state.tool_calls('run_sql').first.output"
        assert trace.contexts.expression == "state.contexts"
        assert trace.spans.expression == "state.spans"
        assert value("42").expression == "'42'"
        assert callable(field("golden_sql"))

    def test_helpers_give_the_same_value_as_the_expression(self):
        state = _full_state(criteria=["Reports the count", "Names the quarter"])
        assert conversation.first_user_message(state) == state.first_user_message()
        assert conversation.last_agent_message(state) == "There were 12 chargebacks."
        assert conversation.transcript(state) == state.transcript()
        assert conversation.messages(state) == list(state.messages)
        assert scenario_source.situation(state) == state.description
        assert scenario_source.criteria(state) == "Reports the count\nNames the quarter"
        assert field("golden_sql")(state) == FIELDS["golden_sql"]
        assert trace.tool_calls("run_sql").last.input(state) == SQL_INPUT
        assert trace.tool_calls("run_sql").last.output(state) == '{"count": 12}'
        assert trace.tool_calls("run_sql").inputs(state) == [SQL_INPUT]
        assert value("x")(state) == "x"

    @pytest.mark.asyncio
    async def test_first_and_last_name_the_pick(self):
        """Scenario: A tool call pick names the call with first or last."""
        messages = [
            *messages_with_tool_call(),
            {
                "role": "assistant",
                "content": None,
                "trace_id": TRACE_2,
                "turn": 2,
                "tool_calls": [
                    {"id": "call_2", "type": "function", "function": {"name": "run_sql", "arguments": '{"sql": "SELECT 2"}'}}
                ],
            },
        ]
        state = state_with(messages=messages)
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.input, state=state) == ResolvedValue(
            value={"sql": "SELECT 2"}
        )
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").first.input, state=state) == ResolvedValue(
            value=SQL_INPUT
        )
        # Scenario: A turn narrows the tool calls
        assert await resolve_mapping(
            mapping=lambda s: s.turns[1].tool_calls("run_sql").inputs, state=state
        ) == ResolvedValue(value=[{"sql": "SELECT 2"}])


class TestInference:
    def test_conversation_inputs_are_inferred(self):
        """Scenario: Unmapped conversation inputs are inferred by name."""
        mappings = infer_evaluator_mappings(inputs=["input", "output", "contexts"], field_names=[])
        assert mappings["input"] is conversation.first_user_message
        assert mappings["output"] is conversation.last_agent_message
        assert mappings["contexts"] is trace.contexts

    def test_expected_like_inputs_map_to_fields_by_name_words(self):
        """Scenario: An expected-like input is inferred to a field by its name words."""
        mappings = infer_evaluator_mappings(
            inputs=["output", "expected_output", "expected_contexts"],
            field_names=["golden_sql", "table_schema"],
        )
        assert mappings["expected_output"].expression == field("golden_sql").expression
        assert mappings["expected_contexts"].expression == field("table_schema").expression

    def test_several_candidate_fields_stay_unmapped(self):
        """Scenario: An expected-like input with several candidate fields stays unmapped."""
        mappings = infer_evaluator_mappings(inputs=["expected_output"], field_names=["golden_sql", "reference_sql"])
        assert "expected_output" not in mappings

    def test_a_tool_call_is_never_inferred(self):
        """Scenario: A tool call source is never inferred."""
        mappings = infer_evaluator_mappings(inputs=["output"], field_names=[])
        assert mappings["output"] is conversation.last_agent_message

    def test_an_explicit_mapping_wins(self):
        """Scenario: An explicit mapping wins over inference."""

        def explicit(state: ScenarioState) -> Any:
            return state.tool_calls("run_sql").last.input

        mappings = infer_evaluator_mappings(inputs=["output"], field_names=[], mappings={"output": explicit})
        assert mappings["output"] is explicit
        literal = infer_evaluator_mappings(inputs=["language"], field_names=[], mappings={"language": "en"})
        assert literal["language"] == "en"

    def test_recognizes_expected_like_inputs(self):
        assert is_expected_like_input("expected_output")
        assert is_expected_like_input("golden_answer")
        assert is_expected_like_input("ground_truth")
        assert not is_expected_like_input("output")


class TestResolution:
    @pytest.mark.asyncio
    async def test_tool_call_comes_from_the_message_tool_calls(self):
        """Scenario: A tool call input resolves from the message tool calls."""
        state = _full_state()
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.input, state=state) == ResolvedValue(
            value=SQL_INPUT
        )
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.output, state=state) == ResolvedValue(
            value='{"count": 12}'
        )

    @pytest.mark.asyncio
    async def test_tool_call_comes_from_the_trace_spans_when_the_messages_carry_none(self):
        """Scenario: A tool call resolves from the trace spans when the messages carry none."""
        state = state_with(
            messages=[{"role": "assistant", "content": "Done.", "trace_id": TRACE_1}],
            spans=[
                span("run_sql", {"langwatch.span.type": "tool", "langwatch.input": '{"sql":"SELECT 1"}', "langwatch.output": "[[1]]"}),
                span("llm", {"langwatch.span.type": "llm"}),
            ],
        )
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.input, state=state) == ResolvedValue(
            value='{"sql":"SELECT 1"}'
        )
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.output, state=state) == ResolvedValue(
            value="[[1]]"
        )

    @pytest.mark.asyncio
    async def test_nothing_carries_the_most_specific_reason(self):
        state = state_with(messages=[{"role": "assistant", "content": "Done.", "trace_id": TRACE_1}])
        # Scenario: A mapping that returns nothing skips the evaluator
        assert await resolve_mapping(mapping=lambda s: None, state=state) == ResolvedNothing(
            reason="the mapping returned nothing", read_trace=False
        )
        assert await resolve_mapping(mapping=lambda s: [], state=state) == ResolvedNothing(
            reason="the mapping returned nothing", read_trace=False
        )
        # Scenario: A blank field skips the evaluator with the field name
        assert await resolve_mapping(mapping=field("golden_sql"), state=state) == ResolvedNothing(
            reason="no golden_sql on this scenario", read_trace=False
        )
        assert await resolve_mapping(mapping=field("golden_sql"), state=state_with(fields={"golden_sql": ""})) == ResolvedNothing(
            reason="no golden_sql on this scenario", read_trace=False
        )
        # Scenario: A missing tool call skips the evaluator with the tool name
        assert await resolve_mapping(mapping=trace.tool_calls("run_sql").last.input, state=state) == ResolvedNothing(
            reason="no run_sql call in the trace", read_trace=True
        )
        assert await resolve_mapping(mapping=trace.contexts, state=state) == ResolvedNothing(
            reason="no retrieved contexts in the trace", read_trace=True
        )
        assert await resolve_mapping(mapping=lambda s: [x for x in s.spans if False], state=state) == ResolvedNothing(
            reason="the mapping returned nothing", read_trace=True
        )

    @pytest.mark.asyncio
    async def test_scenario_definition_and_literal_sources(self):
        state = _full_state(criteria=["Reports the count"])
        assert await resolve_mapping(mapping=scenario_source.situation, state=state) == ResolvedValue(
            value="A fraud analyst asks for chargebacks."
        )
        assert await resolve_mapping(mapping=scenario_source.criteria, state=state) == ResolvedValue(
            value="Reports the count"
        )
        assert await resolve_mapping(mapping=value("x"), state=state) == ResolvedValue(value="x")

    @pytest.mark.asyncio
    async def test_contexts_come_from_rag_spans(self):
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
        assert await resolve_mapping(mapping=trace.contexts, state=state) == ResolvedValue(
            value=["Table chargebacks", "plain text"]
        )


class TestRunner:
    @pytest.mark.asyncio
    async def test_evaluate_receives_the_resolved_data_and_the_last_trace_id(self):
        """Scenario: The evaluate call carries the resolved inputs and the trace id of the last turn."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        [result] = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT], state=_full_state(), trace_id=TRACE_1, deps=fake.deps
        )
        assert fake.calls == [
            {
                "evaluator_ref": "ragas/sql_query_equivalence",
                "data": {
                    "output": SQL_INPUT,
                    "expected_output": FIELDS["golden_sql"],
                    "expected_contexts": [FIELDS["table_schema"]],
                },
                "settings": None,
                "trace_id": TRACE_1,
            }
        ]
        assert fake.fetches == 0
        assert result.evaluator_id == "ragas/sql_query_equivalence"
        assert result.name == "SQL Query Equivalence"
        assert result.status == "passed"
        assert result.required is True
        assert result.passed is True
        assert result.details == "ok"
        assert result.inputs is not None
        assert result.inputs["expected_output"] == FIELDS["golden_sql"]
        assert result.inputs["output"] == '{"sql": "SELECT count(*) FROM chargebacks"}'

    @pytest.mark.asyncio
    async def test_a_required_evaluator_that_fails_fails_the_run(self):
        """Scenario: A required evaluator that fails fails the run."""
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            response={"status": "processed", "passed": False, "details": "Different grouping"},
        )
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT], state=_full_state(), trace_id=TRACE_1, deps=fake.deps
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "failed"
        assert result.success is False
        assert result.reasoning == "All criteria passed\nEvaluator SQL Query Equivalence failed: Different grouping"
        assert result.evaluations == evaluations
        assert result.passed_criteria == ["Reports the count"]

    @pytest.mark.asyncio
    async def test_a_score_never_gates(self):
        """Scenario: A score never gates the run."""
        fake = _FakeDeps(
            {"evaluators/answer-quality": SCORE_JUDGE},
            response={"status": "processed", "score": 0.4, "details": "Vague answer"},
        )
        evaluations = await run_scenario_evaluators(
            evaluators=[evaluator("evaluators/answer-quality", required=True)],
            state=_full_state(),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert fake.calls[0]["data"] == {
            "input": "How many chargebacks last quarter?",
            "output": "There were 12 chargebacks.",
        }
        assert evaluations[0].evaluator_id == "eval_123"
        assert evaluations[0].status == "scored"
        assert evaluations[0].score == 0.4
        assert result.success is True

    @pytest.mark.asyncio
    async def test_required_defaults_to_false_for_a_score_only_evaluator(self):
        fake = _FakeDeps({"evaluators/answer-quality": SCORE_JUDGE}, response={"status": "processed", "score": 0.9})
        [result] = await run_scenario_evaluators(
            evaluators=[evaluator("evaluators/answer-quality")], state=_full_state(), trace_id=None, deps=fake.deps
        )
        assert result.required is False

    @pytest.mark.asyncio
    async def test_an_inferred_optional_input_that_resolves_to_nothing_is_left_out(self):
        fake = _FakeDeps({"evaluators/answer-quality": SCORE_JUDGE})
        await run_scenario_evaluators(
            evaluators=[evaluator("evaluators/answer-quality")],
            state=state_with(messages=[{"role": "user", "content": "Hi", "trace_id": TRACE_1}]),
            trace_id=None,
            deps=fake.deps,
        )
        assert fake.calls[0]["data"] == {"input": "Hi"}

    @pytest.mark.asyncio
    async def test_a_literal_mapping_is_sent_as_the_input(self):
        fake = _FakeDeps({"evaluators/answer-quality": SCORE_JUDGE})
        await run_scenario_evaluators(
            evaluators=[evaluator("evaluators/answer-quality", mappings={"output": "fixed answer"})],
            state=_full_state(),
            trace_id=None,
            deps=fake.deps,
        )
        assert fake.calls[0]["data"]["output"] == "fixed answer"

    @pytest.mark.asyncio
    async def test_a_blank_field_skips_without_calling_the_endpoint(self):
        """Scenario: A blank field skips the evaluator with the field name."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE})
        [result] = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            state=_full_state(fields={"table_schema": "CREATE TABLE ..."}),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        assert result.status == "skipped"
        assert result.required is True
        assert result.details == "no golden_sql on this scenario"
        assert fake.calls == []

    @pytest.mark.asyncio
    async def test_a_missing_tool_call_fetches_once_calls_the_mappings_again_and_skips(self):
        """Scenario: A mapping that read the trace and found nothing fetches the remote traces once."""
        state = _full_state(messages=[{"role": "assistant", "content": "Done.", "trace_id": TRACE_1}])
        calls: List[str] = []
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            fetch_remote_traces=True,
            on_fetch=lambda: calls.append("fetch"),
        )

        def output(s: ScenarioState) -> Any:
            calls.append("output")
            return s.tool_calls("run_sql").last.input

        evaluations = await run_scenario_evaluators(
            evaluators=[
                evaluator(
                    "ragas/sql_query_equivalence",
                    mappings={
                        "output": output,
                        "expected_output": field("golden_sql"),
                        "expected_contexts": trace.tool_calls("run_sql").last.output,
                    },
                )
            ],
            state=state,
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        # Scenario: A missing tool call skips the evaluator with the tool name
        assert evaluations[0].status == "skipped"
        assert evaluations[0].details == "no run_sql call in the trace"
        assert fake.fetches == 1
        assert calls == ["output", "fetch", "output"]
        assert fake.calls == []
        assert result.success is True

    @pytest.mark.asyncio
    async def test_the_fetch_brings_the_call_in(self):
        spans: List[Any] = []
        state = _full_state(messages=[{"role": "assistant", "content": "Done.", "trace_id": TRACE_1}])
        state.set_span_provider(lambda: list(spans))
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            fetch_remote_traces=True,
            on_fetch=lambda: spans.append(
                span("run_sql", {"langwatch.span.type": "tool", "langwatch.input": '{"sql":"SELECT 1"}'})
            ),
        )
        [result] = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT], state=state, trace_id=TRACE_1, deps=fake.deps
        )
        assert result.status == "passed"
        assert fake.calls[0]["data"]["output"] == '{"sql":"SELECT 1"}'

    @pytest.mark.asyncio
    async def test_two_evaluators_that_read_the_trace_fetch_once(self):
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT, SQL_ATTACHMENT],
            state=_full_state(messages=[{"role": "assistant", "content": "Done.", "trace_id": TRACE_1}]),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        assert fake.fetches == 1

    @pytest.mark.asyncio
    async def test_no_fetch_without_trace_ids_on_the_messages(self):
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            state=_full_state(messages=[{"role": "assistant", "content": "Done."}]),
            trace_id=None,
            deps=fake.deps,
        )
        assert fake.fetches == 0

    @pytest.mark.asyncio
    async def test_a_mapping_that_returns_nothing_without_reading_the_trace_never_fetches(self):
        """Scenario: A mapping that did not read the trace never fetches the remote traces."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        [result] = await run_scenario_evaluators(
            evaluators=[
                evaluator(
                    "ragas/sql_query_equivalence",
                    mappings={**SQL_ATTACHMENT.mappings, "output": lambda s: None},
                )
            ],
            state=_full_state(),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        assert result.status == "skipped"
        assert result.details == "the mapping returned nothing"
        assert fake.fetches == 0
        assert fake.calls == []

    @pytest.mark.asyncio
    async def test_a_mapping_that_raises_is_an_error_result(self):
        """Scenario: A mapping that raises errors the evaluator."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE})

        def output(_: ScenarioState) -> Any:
            raise ValueError("no SQL found")

        [result] = await run_scenario_evaluators(
            evaluators=[evaluator("ragas/sql_query_equivalence", mappings={**SQL_ATTACHMENT.mappings, "output": output})],
            state=_full_state(),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        assert result.status == "error"
        assert result.details == "Mapping of output failed: no SQL found"
        assert fake.calls == []

    @pytest.mark.asyncio
    async def test_an_endpoint_failure_is_an_error_result_and_fails_a_required_evaluator(self) -> None:
        """Scenario: An evaluate endpoint failure is reported as an error.
        Scenario: A required evaluator that could not run fails the run."""
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            error=RuntimeError("POST /api/evaluations/x/evaluate answered 500: boom"),
        )
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT], state=_full_state(), trace_id=TRACE_1, deps=fake.deps
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "error"
        assert evaluations[0].details == "POST /api/evaluations/x/evaluate answered 500: boom"
        assert result.success is False
        assert result.reasoning == (
            "All criteria passed\nEvaluator SQL Query Equivalence could not run: "
            "POST /api/evaluations/x/evaluate answered 500: boom"
        )

    @pytest.mark.asyncio
    async def test_an_optional_evaluator_that_could_not_run_leaves_the_verdict(self) -> None:
        """Scenario: An optional evaluator that could not run leaves the verdict."""
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            error=RuntimeError("POST /api/evaluations/x/evaluate answered 500: boom"),
        )
        optional = evaluator("ragas/sql_query_equivalence", required=False, mappings=SQL_ATTACHMENT.mappings)
        evaluations = await run_scenario_evaluators(
            evaluators=[optional], state=_full_state(), trace_id=TRACE_1, deps=fake.deps
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "error"
        assert result.success is True
        assert result.reasoning == "All criteria passed"

    @pytest.mark.asyncio
    async def test_a_skipped_required_evaluator_never_gates(self) -> None:
        """Scenario: A skipped evaluator never gates the run."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE})
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            state=_full_state(fields={"table_schema": "CREATE TABLE ..."}),
            trace_id=TRACE_1,
            deps=fake.deps,
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "skipped"
        assert result.success is True

    @pytest.mark.asyncio
    async def test_an_unknown_evaluator_is_an_error_result(self):
        fake = _FakeDeps({})
        [result] = await run_scenario_evaluators(
            evaluators=[evaluator("langevals/nope")], state=_full_state(), trace_id=None, deps=fake.deps
        )
        assert result.status == "error"
        assert result.details == "Evaluator langevals/nope was not found in LangWatch"

    @pytest.mark.asyncio
    async def test_a_required_input_without_mapping_is_an_error_result(self):
        fake = _FakeDeps(
            {
                "ragas/sql_query_equivalence": EvaluatorSpec(
                    evaluator_id="ragas/sql_query_equivalence",
                    name="SQL Query Equivalence",
                    inputs=[EvaluatorInput(id="expected_output", required=True)],
                )
            }
        )
        [result] = await run_scenario_evaluators(
            evaluators=[evaluator("ragas/sql_query_equivalence")],
            state=_full_state(fields={}),
            trace_id=None,
            deps=fake.deps,
        )
        assert result.status == "error"
        assert "expected_output" in (result.details or "")


class _SqlAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> Any:
        return [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "run_sql", "arguments": '{"sql": "SELECT 1"}'},
                    }
                ],
            },
            {"role": "assistant", "content": "The answer is 1."},
        ]


class _MockUserSimulatorAgent(UserSimulatorAgent):
    async def call(self, input: AgentInput) -> str:
        return "What is one?"


class _MockJudgeAgent(JudgeAgent):
    async def call(self, input: AgentInput) -> Any:
        if input.judgment_request is None:
            return None
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="All criteria passed",
            passed_criteria=["Answers the question"],
        )


class _MockEventReporter(EventReporter):
    def __init__(self) -> None:
        super().__init__(endpoint="http://localhost", api_key="sk-test")
        self.posted_events: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        self.posted_events.append(event)
        return {}


class TestRunEvents:
    """Scenario: The run finished event carries the evaluations."""

    @pytest.fixture
    def evaluate_response(self) -> Dict[str, Any]:
        return {"status": "processed", "passed": True, "details": "Match"}

    @pytest.fixture
    def fake_api(self, monkeypatch: pytest.MonkeyPatch, evaluate_response: Dict[str, Any]) -> List[Dict[str, Any]]:
        from scenario import scenario_executor
        from scenario._evaluators.api import EvaluationsApiAuth

        calls: List[Dict[str, Any]] = []

        class FakeClient:
            def __init__(self, auth: EvaluationsApiAuth) -> None:
                self.auth = auth

            async def get_evaluator_spec(self, ref: str) -> Optional[EvaluatorSpec]:
                return EvaluatorSpec(
                    evaluator_id="langevals/exact_match",
                    name="Exact Match",
                    inputs=[EvaluatorInput(id="output", required=True), EvaluatorInput(id="expected_output", required=True)],
                )

            async def evaluate(self, **kwargs: Any) -> Dict[str, Any]:
                calls.append(kwargs)
                return evaluate_response

        monkeypatch.setattr(scenario_executor, "EvaluationsApiClient", FakeClient)
        monkeypatch.setattr(
            scenario_executor,
            "resolve_evaluations_api_auth",
            lambda: EvaluationsApiAuth(endpoint="http://localhost", api_key="sk-test", project_id=""),
        )
        return calls

    async def _run(self, evaluators: Optional[List[Any]]) -> tuple[ScenarioResult, List[ScenarioEvent]]:
        events: List[ScenarioEvent] = []
        executor = ScenarioExecutor(
            name="chargebacks",
            description="A user asks what one is",
            agents=[_SqlAgent(), _MockUserSimulatorAgent(model="none"), _MockJudgeAgent(model="none", criteria=["Answers the question"])],
            script=[user("What is one?"), agent(), judge()],
            event_bus=ScenarioEventBus(event_reporter=_MockEventReporter()),
            fields={"golden_sql": "SELECT 1"},
            evaluators=evaluators,
        )
        executor.events.subscribe(lambda event: events.append(event))
        result = await executor.run()
        return result, events

    @pytest.mark.asyncio
    async def test_the_events_and_the_result_carry_the_fields_and_the_evaluation(self, fake_api: List[Dict[str, Any]]):
        result, events = await self._run(
            [
                evaluator(
                    "langevals/exact_match",
                    mappings={
                        "output": lambda state: state.tool_calls("run_sql").last.input,
                        "expected_output": field("golden_sql"),
                    },
                )
            ]
        )
        # Scenario: The run started event carries the fields
        started = [event for event in events if isinstance(event, ScenarioRunStartedEvent)]
        assert started[0].to_dict()["metadata"]["fields"] == {"golden_sql": "SELECT 1"}
        finished = [event for event in events if isinstance(event, ScenarioRunFinishedEvent)]
        assert len(finished) == 1
        assert fake_api[0]["evaluator_ref"] == "langevals/exact_match"
        assert fake_api[0]["data"] == {"output": {"sql": "SELECT 1"}, "expected_output": "SELECT 1"}
        assert finished[0].to_dict()["results"]["evaluations"] == [
            {
                "evaluatorId": "langevals/exact_match",
                "name": "Exact Match",
                "status": "passed",
                "required": True,
                "passed": True,
                "details": "Match",
                "inputs": {"output": '{"sql": "SELECT 1"}', "expected_output": "SELECT 1"},
            }
        ]
        assert [evaluation.to_wire() for evaluation in result.evaluations] == finished[0].to_dict()["results"]["evaluations"]
        assert result.success is True
        assert finished[0].to_dict()["results"]["verdict"] == "success"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("evaluate_response", [{"status": "processed", "passed": False, "details": "No match"}])
    async def test_a_required_evaluator_that_fails_fails_the_run(self, fake_api: List[Dict[str, Any]]):
        result, events = await self._run(
            [
                evaluator(
                    "langevals/exact_match",
                    mappings={"output": trace.tool_calls("run_sql").last.input, "expected_output": field("golden_sql")},
                )
            ]
        )
        finished = [event for event in events if isinstance(event, ScenarioRunFinishedEvent)]
        assert result.success is False
        assert "Evaluator Exact Match failed: No match" in (result.reasoning or "")
        assert finished[0].to_dict()["status"] == "FAILED"
        assert finished[0].to_dict()["results"]["verdict"] == "failure"
        assert finished[0].to_dict()["results"]["evaluations"][0]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_skipped_and_error_results_next_to_a_passed_one(self, fake_api: List[Dict[str, Any]]):
        def boom(_: ScenarioState) -> Any:
            raise ValueError("no SQL found")

        result, events = await self._run(
            [
                evaluator("langevals/exact_match", mappings={"output": trace.tool_calls("run_sql").last.input}),
                evaluator("langevals/exact_match", mappings={"output": lambda state: state.tool_calls("lookup").last.input}),
                evaluator("langevals/exact_match", mappings={"output": boom}),
            ]
        )
        assert [evaluation.status for evaluation in result.evaluations] == ["passed", "skipped", "error"]
        assert result.evaluations[1].details == "no lookup call in the trace"
        assert result.evaluations[2].details == "Mapping of output failed: no SQL found"
        assert len(fake_api) == 1
        # Scenario: A required evaluator that could not run fails the run
        assert result.success is False
        assert "Evaluator Exact Match could not run: Mapping of output failed" in (result.reasoning or "")
        finished = [event for event in events if isinstance(event, ScenarioRunFinishedEvent)]
        assert finished[0].to_dict()["status"] == "FAILED"

    @pytest.mark.asyncio
    async def test_a_run_without_evaluators_sends_no_evaluations(self, fake_api: List[Dict[str, Any]]):
        """Scenario: A run without evaluators sends no evaluations."""
        result, events = await self._run(None)
        finished = [event for event in events if isinstance(event, ScenarioRunFinishedEvent)]
        assert fake_api == []
        assert "evaluations" not in finished[0].to_dict()["results"]
        assert result.evaluations == []
