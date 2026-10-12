package evaluators

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func sqlAttachment(opts ...Option) scenario.ScenarioEvaluator {
	base := []Option{
		Required(true),
		Map("output", func(s *scenario.ExecutionState) any {
			c, ok := s.ToolCalls("run_sql").Last()
			if !ok {
				return nil
			}
			return c.Input
		}),
		Map("expected_output", Field("golden_sql")),
		Map("expected_contexts", func(s *scenario.ExecutionState) any { v, _ := s.Field("table_schema"); return v }),
	}
	return Evaluator("ragas/sql_query_equivalence", append(base, opts...)...)
}

func judgeSuccess() *scenario.ScenarioResult {
	return &scenario.ScenarioResult{Success: true, Reasoning: "All criteria passed", MetCriteria: []string{"Reports totals"}, UnmetCriteria: []string{}}
}

// runIn runs the evaluators over the fixture state.
func runIn(t *testing.T, fx fixture, api *fakeAPI, fetch func(ctx context.Context), evaluators ...scenario.ScenarioEvaluator) []scenario.EvaluationResult {
	t.Helper()
	var out []scenario.EvaluationResult
	withState(t, fx, func(ctx context.Context, ex *scenario.Executor) {
		traceID := ""
		if ids := scenario.MessageTraceIDs(ex.State().Messages()); len(ids) > 0 {
			traceID = ids[len(ids)-1]
		}
		out = Run(ctx, RunInput{Evaluators: evaluators, State: ex.State(), TraceID: traceID, API: api, FetchRemoteTraces: fetch})
	})
	return out
}

func full() fixture { return fixture{messages: messagesWithToolCall(), fields: fields} }

func TestRunCallsEvaluateWithResolvedData(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	fetches := 0
	res := runIn(t, full(), api, func(context.Context) { fetches++ }, sqlAttachment())

	calls := api.evaluateCalls()
	if len(calls) != 1 {
		t.Fatalf("calls %d", len(calls))
	}
	body := string(requestBody(calls[0]))
	want := `{"data":{"output":{"sql":"` + sqlQuery + `"},"expected_output":"` + fields["golden_sql"].(string) + `","expected_contexts":["` + fields["table_schema"].(string) + `"]},"trace_id":"trace-1"}`
	if body != want {
		t.Errorf("body\n%s\nwant\n%s", body, want)
	}
	r := res[0]
	if r.EvaluatorID != "ragas/sql_query_equivalence" || r.Name != "SQL Query Equivalence" || r.Status != scenario.EvaluationPassed ||
		!r.Required || r.Passed == nil || !*r.Passed || r.Details != "ok" {
		t.Errorf("result %+v", r)
	}
	if r.Inputs["expected_output"] != fields["golden_sql"] || r.Inputs["output"] != `{"sql":"`+sqlQuery+`"}` {
		t.Errorf("inputs %v", r.Inputs)
	}
	if fetches != 0 {
		t.Error("must not fetch when the messages carry the tool call")
	}
}

func TestRunFailedRequiredEvaluatorFailsRun(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence},
		response: &EvaluateResponse{Status: "processed", Passed: ptr(false), Details: ptr("Different grouping")}}
	evals := runIn(t, full(), api, nil, sqlAttachment())
	result := judgeSuccess()
	Apply(result, evals)
	if evals[0].Status != scenario.EvaluationFailed || result.Success {
		t.Fatalf("evals %+v result %+v", evals, result)
	}
	if result.Reasoning != "All criteria passed\nEvaluator SQL Query Equivalence failed: Different grouping" {
		t.Errorf("reasoning %q", result.Reasoning)
	}
	if !slices.Equal(result.MetCriteria, []string{"Reports totals"}) || len(result.Evaluations) != 1 {
		t.Errorf("result %+v", result)
	}
}

func TestRunBlankFieldSkips(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	fx := full()
	fx.fields = map[string]scenario.FieldValue{"table_schema": fields["table_schema"]}
	evals := runIn(t, fx, api, nil, sqlAttachment())
	if r := evals[0]; r.Status != scenario.EvaluationSkipped || !r.Required || r.Details != "no golden_sql on this scenario" {
		t.Errorf("result %+v", r)
	}
	if len(api.evaluateCalls()) != 0 {
		t.Error("skipped evaluator must not be called")
	}
	result := judgeSuccess()
	Apply(result, evals)
	if !result.Success {
		t.Error("a skip never gates")
	}
}

func noCall() fixture {
	return fixture{messages: []scenario.Message{{Role: scenario.RoleAssistant, Content: "Done.", TraceID: "trace-1"}}, fields: fields}
}

func TestRunFetchesRemoteTracesOnceThenSkips(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	var calls []string
	att := Evaluator("ragas/sql_query_equivalence",
		Map("output", func(s *scenario.ExecutionState) any {
			calls = append(calls, "output")
			c, ok := s.ToolCalls("run_sql").Last()
			if !ok {
				return nil
			}
			return c.Input
		}),
		Map("expected_output", Field("golden_sql")),
		Map("expected_contexts", Trace.ToolCalls("run_sql").Last.Output),
	)
	evals := runIn(t, noCall(), api, func(context.Context) { calls = append(calls, "fetch") }, att)
	if r := evals[0]; r.Status != scenario.EvaluationSkipped || !r.Required || r.Details != "no run_sql call in the trace" {
		t.Errorf("result %+v", r)
	}
	if !slices.Equal(calls, []string{"output", "fetch", "output"}) {
		t.Errorf("calls %v", calls)
	}
	if len(api.evaluateCalls()) != 0 {
		t.Error("must not evaluate")
	}
}

func TestRunFindsCallTheFetchBroughtIn(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	var evals []scenario.EvaluationResult
	withState(t, noCall(), func(ctx context.Context, ex *scenario.Executor) {
		evals = Run(ctx, RunInput{Evaluators: []scenario.ScenarioEvaluator{sqlAttachment()}, State: ex.State(), API: api,
			FetchRemoteTraces: func(context.Context) {
				addSpan(ex.ThreadID(), spanFixture{name: "run_sql", attrs: map[string]string{"langwatch.span.type": "tool", "langwatch.input": `{"sql":"SELECT 1"}`}})
			}})
	})
	if evals[0].Status != scenario.EvaluationPassed {
		t.Fatalf("result %+v", evals[0])
	}
	if got := api.evaluateCalls()[0].Data["output"]; got != `{"sql":"SELECT 1"}` {
		t.Errorf("output %v", got)
	}
}

func TestRunFetchesOnceForTwoEvaluators(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	fetches := 0
	runIn(t, noCall(), api, func(context.Context) { fetches++ }, sqlAttachment(), sqlAttachment())
	if fetches != 1 {
		t.Errorf("fetches %d", fetches)
	}
}

func TestRunNoFetchWithoutTraceIDs(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	fetches := 0
	fx := fixture{messages: []scenario.Message{{Role: scenario.RoleAssistant, Content: "Done."}}, fields: fields}
	evals := runIn(t, fx, api, func(context.Context) { fetches++ }, sqlAttachment())
	if fetches != 0 {
		t.Error("fetched without trace ids")
	}
	result := judgeSuccess()
	Apply(result, evals)
	if !result.Success {
		t.Error("the judge's verdict must stand")
	}
}

func TestRunNothingWithoutTraceReadNeverFetches(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	fetches := 0
	evals := runIn(t, full(), api, func(context.Context) { fetches++ },
		sqlAttachment(Map("output", func(*scenario.ExecutionState) any { return nil })))
	if r := evals[0]; r.Status != scenario.EvaluationSkipped || r.Details != "the mapping returned nothing" {
		t.Errorf("result %+v", r)
	}
	if fetches != 0 || len(api.evaluateCalls()) != 0 {
		t.Error("must neither fetch nor evaluate")
	}
}

func TestRunMappingErrorReportsError(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}}
	evals := runIn(t, full(), api, nil, sqlAttachment(Map("output", scenario.MappingFunc(func(context.Context, *scenario.ExecutionState) (any, error) {
		return nil, errors.New("no SQL found")
	}))))
	if r := evals[0]; r.Status != scenario.EvaluationError || r.Details != "Mapping of output failed: no SQL found" {
		t.Errorf("result %+v", r)
	}
	if len(api.evaluateCalls()) != 0 {
		t.Error("must not evaluate")
	}
}

func TestRunEndpointErrorGatesRequiredOnly(t *testing.T) {
	boom := errors.New("Evaluation API answered 500: boom")
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": sqlEquivalence}, err: boom}
	evals := runIn(t, full(), api, nil, sqlAttachment())
	result := judgeSuccess()
	Apply(result, evals)
	if evals[0].Status != scenario.EvaluationError || evals[0].Details != boom.Error() || result.Success {
		t.Fatalf("evals %+v result %+v", evals, result)
	}
	if result.Reasoning != "All criteria passed\nEvaluator SQL Query Equivalence could not run: Evaluation API answered 500: boom" {
		t.Errorf("reasoning %q", result.Reasoning)
	}

	evals = runIn(t, full(), api, nil, sqlAttachment(Required(false)))
	result = judgeSuccess()
	Apply(result, evals)
	if evals[0].Status != scenario.EvaluationError || !result.Success || result.Reasoning != "All criteria passed" {
		t.Errorf("optional: evals %+v result %+v", evals, result)
	}
}

func TestRunScoreNeverGates(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"evaluators/answer-quality": scoreJudge},
		response: &EvaluateResponse{Status: "processed", Score: ptr(0.4), Details: ptr("Vague answer")}}
	evals := runIn(t, full(), api, nil, Evaluator("evaluators/answer-quality", Required(true)))
	result := judgeSuccess()
	Apply(result, evals)
	call := api.evaluateCalls()[0]
	if call.EvaluatorRef != "evaluators/answer-quality" || len(call.Data) != 2 ||
		call.Data["input"] != "How many chargebacks last quarter?" || call.Data["output"] != "There were 12 chargebacks." {
		t.Errorf("call %+v", call)
	}
	r := evals[0]
	if r.EvaluatorID != "eval_123" || r.Name != "Answer quality" || r.Status != scenario.EvaluationScored || *r.Score != 0.4 || !r.Required {
		t.Errorf("result %+v", r)
	}
	if !result.Success {
		t.Error("a score never gates")
	}
}

func TestRunScoreOnlyDefaultsToOptional(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"evaluators/answer-quality": scoreJudge},
		response: &EvaluateResponse{Status: "processed", Score: ptr(0.9)}}
	if evals := runIn(t, full(), api, nil, Evaluator("evaluators/answer-quality")); evals[0].Required {
		t.Error("score-only evaluator must default to optional")
	}
}

func TestRunLeavesOutInferredOptionalNothing(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"evaluators/answer-quality": scoreJudge}}
	runIn(t, fixture{messages: []scenario.Message{{Role: scenario.RoleUser, Content: "Hi", TraceID: "trace-1"}}}, api, nil, Evaluator("evaluators/answer-quality"))
	if data := api.evaluateCalls()[0].Data; len(data) != 1 || data["input"] != "Hi" {
		t.Errorf("data %v", data)
	}
}

func TestRunSendsLiteral(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"evaluators/answer-quality": scoreJudge}}
	runIn(t, full(), api, nil, Evaluator("evaluators/answer-quality", Map("output", "fixed answer")))
	if got := api.evaluateCalls()[0].Data["output"]; got != "fixed answer" {
		t.Errorf("output %v", got)
	}
}

func TestRunUnknownEvaluator(t *testing.T) {
	evals := runIn(t, full(), &fakeAPI{}, nil, Evaluator("langevals/nope"))
	if r := evals[0]; r.EvaluatorID != "langevals/nope" || r.Status != scenario.EvaluationError || r.Details != "Evaluator langevals/nope was not found in LangWatch" {
		t.Errorf("result %+v", r)
	}
}

func TestRunUncoveredRequiredInput(t *testing.T) {
	spec := *sqlEquivalence
	spec.Inputs = []Input{{ID: "expected_output", Required: true}}
	fx := full()
	fx.fields = nil
	evals := runIn(t, fx, &fakeAPI{specs: map[string]*EvaluatorSpec{"ragas/sql_query_equivalence": &spec}}, nil, Evaluator("ragas/sql_query_equivalence"))
	if r := evals[0]; r.Status != scenario.EvaluationError || !strings.Contains(r.Details, "expected_output") {
		t.Errorf("result %+v", r)
	}
}

func BenchmarkRequestBody(b *testing.B) {
	req := EvaluateRequest{
		EvaluatorRef: "ragas/sql_query_equivalence",
		Data: map[string]any{
			"output":            map[string]any{"sql": sqlQuery},
			"expected_output":   fields["golden_sql"],
			"expected_contexts": []any{fields["table_schema"]},
		},
		Order:   []string{"output", "expected_output", "expected_contexts"},
		TraceID: "trace-1",
	}
	b.ReportAllocs()
	for b.Loop() {
		requestBody(req)
	}
}
