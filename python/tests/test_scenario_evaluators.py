"""
Ref: specs/scenario-evaluators.feature

Evaluators on scenario runs: mapping inference, input resolution, the gate a
required evaluator applies to the run, and the evaluations on the run
finished event.
"""

from typing import Any, Dict, List, Optional

import pytest
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanContext, TraceFlags

from scenario import JudgeAgent, UserSimulatorAgent, agent, judge, user
from scenario._evaluators import (
    EvaluatorInput,
    EvaluatorInputContext,
    EvaluatorSpec,
    ResolvedFailed,
    ResolvedSkipped,
    ResolvedValue,
    RunEvaluatorsDeps,
    apply_evaluations_to_result,
    infer_evaluator_mappings,
    is_expected_like_input,
    resolve_input,
    run_scenario_evaluators,
)
from scenario._events import (
    EventReporter,
    ScenarioEvent,
    ScenarioEventBus,
    ScenarioRunFinishedEvent,
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
from scenario.types import AgentInput, ScenarioResult


def _span(name: str, attributes: Dict[str, Any]) -> ReadableSpan:
    return ReadableSpan(
        name=name,
        context=SpanContext(
            trace_id=1, span_id=hash(name) & 0xFFFFFFFFFFFFFFFF, is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        ),
        attributes=attributes,
    )


MESSAGES_WITH_TOOL_CALL: List[Dict[str, Any]] = [
    {"role": "user", "content": "How many chargebacks last quarter?", "trace_id": "trace-1"},
    {
        "role": "assistant",
        "content": None,
        "trace_id": "trace-2",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "run_sql",
                    "arguments": '{"sql": "SELECT count(*) FROM chargebacks"}',
                },
            }
        ],
    },
    {"role": "tool", "tool_call_id": "call_1", "content": '{"count": 12}', "trace_id": "trace-2"},
    {"role": "assistant", "content": "There were 12 chargebacks.", "trace_id": "trace-2"},
]


def _context(**overrides: Any) -> EvaluatorInputContext:
    base: Dict[str, Any] = dict(
        messages=[],
        description="A fraud analyst asks for chargebacks.",
        criteria=["Reports the count"],
        fields={},
        spans=[],
    )
    base.update(overrides)
    return EvaluatorInputContext(**base)


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


class _FakeDeps:
    def __init__(
        self,
        specs: Dict[str, EvaluatorSpec],
        response: Optional[Dict[str, Any]] = None,
        error: Optional[Exception] = None,
        fetch_remote_traces: bool = False,
    ) -> None:
        self.specs = specs
        self.response = response or {"status": "processed", "passed": True, "details": "ok"}
        self.error = error
        self.calls: List[Dict[str, Any]] = []
        self.fetches = 0
        self.deps = RunEvaluatorsDeps(
            get_evaluator_spec=self._spec,
            evaluate=self._evaluate,
            get_spans=lambda: [],
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


FIELDS = {
    "golden_sql": "SELECT count(*) FROM chargebacks",
    "table_schema": "CREATE TABLE chargebacks (...)",
}

SQL_ATTACHMENT = evaluator(
    "ragas/sql_query_equivalence",
    required=True,
    mappings={
        "output": trace.tool_call("run_sql").input,
        "expected_output": field("golden_sql"),
        "expected_contexts": field("table_schema"),
    },
)


def _judge_success() -> ScenarioResult:
    return ScenarioResult(
        success=True,
        messages=[],
        reasoning="All criteria passed",
        passed_criteria=["Reports the count"],
    )


class TestMappingHelpers:
    """Scenario: Mapping helpers build the platform mapping shape."""

    def test_helpers_build_the_platform_shape(self):
        assert conversation.first_user_message.to_wire() == {
            "type": "source",
            "sourceId": "conversation",
            "path": ["first_user_message"],
        }
        assert field("golden_sql").to_wire() == {
            "type": "source",
            "sourceId": "scenario",
            "path": ["fields", "golden_sql"],
        }
        assert trace.tool_call("run_sql").input.path == ["tool_calls", "run_sql", "input"]
        assert trace.tool_call("run_sql").output.path == ["tool_calls", "run_sql", "output"]
        assert trace.contexts.path == ["contexts"]
        assert value("42").to_wire() == {"type": "value", "value": "42"}


class TestInference:
    """Scenario: Unmapped conversation inputs are inferred by name."""

    def test_conversation_inputs_are_inferred(self):
        mappings = infer_evaluator_mappings(
            inputs=["input", "output", "contexts"], field_names=[]
        )
        assert mappings["input"] == conversation.first_user_message
        assert mappings["output"] == conversation.last_agent_message
        assert mappings["contexts"] == trace.contexts

    def test_expected_like_inputs_map_to_fields_by_name_words(self):
        """Scenario: An expected-like input is inferred to a field by its name words."""
        mappings = infer_evaluator_mappings(
            inputs=["output", "expected_output", "expected_contexts"],
            field_names=["golden_sql", "table_schema"],
        )
        assert mappings["expected_output"] == field("golden_sql")
        assert mappings["expected_contexts"] == field("table_schema")

    def test_several_candidate_fields_stay_unmapped(self):
        """Scenario: An expected-like input with several candidate fields stays unmapped."""
        mappings = infer_evaluator_mappings(
            inputs=["expected_output"], field_names=["golden_sql", "reference_sql"]
        )
        assert "expected_output" not in mappings

    def test_a_tool_call_is_never_inferred(self):
        """Scenario: A tool call source is never inferred."""
        mappings = infer_evaluator_mappings(inputs=["output"], field_names=[])
        assert mappings["output"] == conversation.last_agent_message

    def test_an_explicit_mapping_wins(self):
        """Scenario: An explicit mapping wins over inference."""
        explicit = trace.tool_call("run_sql").input
        mappings = infer_evaluator_mappings(
            inputs=["output"], field_names=[], mappings={"output": explicit}
        )
        assert mappings["output"] is explicit

    def test_recognizes_expected_like_inputs(self):
        assert is_expected_like_input("expected_output")
        assert is_expected_like_input("golden_answer")
        assert is_expected_like_input("ground_truth")
        assert not is_expected_like_input("output")


class TestResolution:
    """Scenario: A tool call input resolves from the message tool calls."""

    def test_tool_call_input_comes_from_the_message_tool_calls(self):
        resolved = resolve_input(
            mapping=trace.tool_call("run_sql").input,
            context=_context(messages=MESSAGES_WITH_TOOL_CALL),
        )
        assert resolved == ResolvedValue(value={"sql": "SELECT count(*) FROM chargebacks"})

    def test_tool_call_output_comes_from_the_tool_message(self):
        resolved = resolve_input(
            mapping=trace.tool_call("run_sql").output,
            context=_context(messages=MESSAGES_WITH_TOOL_CALL),
        )
        assert resolved == ResolvedValue(value='{"count": 12}')

    def test_conversation_sources(self):
        context = _context(messages=MESSAGES_WITH_TOOL_CALL)
        assert resolve_input(mapping=conversation.first_user_message, context=context) == ResolvedValue(
            value="How many chargebacks last quarter?"
        )
        assert resolve_input(mapping=conversation.last_agent_message, context=context) == ResolvedValue(
            value="There were 12 chargebacks."
        )
        transcript = resolve_input(mapping=conversation.transcript, context=context)
        assert isinstance(transcript, ResolvedValue)
        assert "user: How many chargebacks last quarter?" in transcript.value
        assert "run_sql" in transcript.value

    def test_tool_call_comes_from_the_trace_spans_when_the_messages_carry_none(self):
        """Scenario: A tool call resolves from the trace spans when the messages carry none."""
        context = _context(
            messages=[{"role": "assistant", "content": "Done."}],
            spans=[
                _span("run_sql", {"langwatch.span.type": "tool", "langwatch.input": '{"sql":"SELECT 1"}', "langwatch.output": "[[1]]"}),
                _span("llm", {"langwatch.span.type": "llm"}),
            ],
        )
        assert resolve_input(mapping=trace.tool_call("run_sql").input, context=context) == ResolvedValue(
            value='{"sql":"SELECT 1"}'
        )
        assert resolve_input(mapping=trace.tool_call("run_sql").output, context=context) == ResolvedValue(
            value="[[1]]"
        )

    def test_missing_tool_call_fails_with_a_reason(self):
        """Scenario: A missing tool call fails the evaluator with a reason."""
        resolved = resolve_input(
            mapping=trace.tool_call("run_sql").input,
            context=_context(messages=[{"role": "assistant", "content": "Done."}]),
        )
        assert resolved == ResolvedFailed(reason="no run_sql call in the trace")

    def test_blank_field_skips_with_a_reason(self):
        """Scenario: A blank field skips the evaluator with a reason."""
        assert resolve_input(mapping=field("golden_sql"), context=_context()) == ResolvedSkipped(
            reason="no golden_sql on this scenario"
        )
        assert resolve_input(
            mapping=field("golden_sql"), context=_context(fields={"golden_sql": ""})
        ) == ResolvedSkipped(reason="no golden_sql on this scenario")
        assert resolve_input(
            mapping=field("golden_sql"), context=_context(fields={"golden_sql": "SELECT 1"})
        ) == ResolvedValue(value="SELECT 1")

    def test_scenario_definition_and_literal_sources(self):
        context = _context()
        assert resolve_input(mapping=scenario_source.situation, context=context) == ResolvedValue(
            value="A fraud analyst asks for chargebacks."
        )
        assert resolve_input(mapping=scenario_source.criteria, context=context) == ResolvedValue(
            value="Reports the count"
        )
        assert resolve_input(mapping=value("x"), context=context) == ResolvedValue(value="x")

    def test_contexts_come_from_rag_spans(self):
        context = _context(
            spans=[
                _span(
                    "retrieve",
                    {
                        "langwatch.span.type": "rag",
                        "langwatch.rag_contexts": '[{"document_id": "a", "content": "Table chargebacks"}, "plain text"]',
                    },
                )
            ]
        )
        assert resolve_input(mapping=trace.contexts, context=context) == ResolvedValue(
            value=["Table chargebacks", "plain text"]
        )
        assert resolve_input(mapping=trace.contexts, context=_context()) == ResolvedFailed(
            reason="no retrieved contexts in the trace"
        )


class TestRunner:
    """Scenario: The evaluate call carries the resolved inputs and the trace id of the last turn."""

    @pytest.mark.asyncio
    async def test_evaluate_receives_the_resolved_data_and_the_last_trace_id(self):
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        [result] = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            context=_context(messages=MESSAGES_WITH_TOOL_CALL, fields=FIELDS),
            trace_id="trace-2",
            deps=fake.deps,
        )
        assert fake.calls == [
            {
                "evaluator_ref": "ragas/sql_query_equivalence",
                "data": {
                    "output": {"sql": "SELECT count(*) FROM chargebacks"},
                    "expected_output": "SELECT count(*) FROM chargebacks",
                    "expected_contexts": ["CREATE TABLE chargebacks (...)"],
                },
                "settings": None,
                "trace_id": "trace-2",
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
        assert result.inputs["expected_output"] == "SELECT count(*) FROM chargebacks"

    @pytest.mark.asyncio
    async def test_a_required_evaluator_that_fails_fails_the_run(self):
        """Scenario: A required evaluator that fails fails the run."""
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            response={"status": "processed", "passed": False, "details": "Different grouping"},
        )
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            context=_context(messages=MESSAGES_WITH_TOOL_CALL, fields=FIELDS),
            trace_id="trace-2",
            deps=fake.deps,
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
            context=_context(messages=MESSAGES_WITH_TOOL_CALL, fields=FIELDS),
            trace_id="trace-2",
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
            evaluators=[evaluator("evaluators/answer-quality")],
            context=_context(messages=MESSAGES_WITH_TOOL_CALL),
            trace_id=None,
            deps=fake.deps,
        )
        assert result.required is False

    @pytest.mark.asyncio
    async def test_a_blank_field_skips_without_calling_the_endpoint(self):
        """Scenario: A blank field skips the evaluator with a reason."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE})
        [result] = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            context=_context(messages=MESSAGES_WITH_TOOL_CALL, fields={"table_schema": "CREATE TABLE ..."}),
            trace_id="trace-2",
            deps=fake.deps,
        )
        assert result.status == "skipped"
        assert result.required is True
        assert result.details == "no golden_sql on this scenario"
        assert fake.calls == []

    @pytest.mark.asyncio
    async def test_a_missing_tool_call_fails_after_one_remote_fetch(self):
        """Scenario: A missing tool call fails the evaluator with a reason."""
        fake = _FakeDeps({"ragas/sql_query_equivalence": SQL_EQUIVALENCE}, fetch_remote_traces=True)
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            context=_context(messages=[{"role": "assistant", "content": "Done."}], fields=FIELDS),
            trace_id=None,
            deps=fake.deps,
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "failed"
        assert evaluations[0].passed is False
        assert evaluations[0].details == "no run_sql call in the trace"
        assert fake.fetches == 1
        assert fake.calls == []
        assert result.success is False
        assert "no run_sql call in the trace" in (result.reasoning or "")

    @pytest.mark.asyncio
    async def test_an_endpoint_failure_is_an_error_result(self):
        """Scenario: An evaluate endpoint failure is reported as an error."""
        fake = _FakeDeps(
            {"ragas/sql_query_equivalence": SQL_EQUIVALENCE},
            error=RuntimeError("POST /api/evaluations/x/evaluate answered 500: boom"),
        )
        evaluations = await run_scenario_evaluators(
            evaluators=[SQL_ATTACHMENT],
            context=_context(messages=MESSAGES_WITH_TOOL_CALL, fields=FIELDS),
            trace_id="trace-2",
            deps=fake.deps,
        )
        result = apply_evaluations_to_result(result=_judge_success(), evaluations=evaluations)
        assert evaluations[0].status == "error"
        assert evaluations[0].details == "POST /api/evaluations/x/evaluate answered 500: boom"
        assert result.success is True
        assert result.reasoning == "All criteria passed"

    @pytest.mark.asyncio
    async def test_an_unknown_evaluator_is_an_error_result(self):
        fake = _FakeDeps({})
        [result] = await run_scenario_evaluators(
            evaluators=[evaluator("langevals/nope")],
            context=_context(),
            trace_id=None,
            deps=fake.deps,
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
            context=_context(),
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
        self.posted_events: List[ScenarioEvent] = []

    async def post_event(self, event: ScenarioEvent) -> Dict[str, Any]:
        self.posted_events.append(event)
        return {}


class TestRunFinishedEvent:
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
    async def test_the_event_and_the_result_carry_the_evaluation(self, fake_api: List[Dict[str, Any]]):
        result, events = await self._run(
            [
                evaluator(
                    "langevals/exact_match",
                    mappings={"output": trace.tool_call("run_sql").input, "expected_output": field("golden_sql")},
                )
            ]
        )
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
                    mappings={"output": trace.tool_call("run_sql").input, "expected_output": field("golden_sql")},
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
    async def test_a_run_without_evaluators_sends_no_evaluations(self, fake_api: List[Dict[str, Any]]):
        """Scenario: A run without evaluators sends no evaluations."""
        result, events = await self._run(None)
        finished = [event for event in events if isinstance(event, ScenarioRunFinishedEvent)]
        assert fake_api == []
        assert "evaluations" not in finished[0].to_dict()["results"]
        assert result.evaluations == []
