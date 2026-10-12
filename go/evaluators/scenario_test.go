package evaluators

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// sqlAgent calls run_sql, then answers.
type sqlAgent struct{}

func (sqlAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }
func (sqlAgent) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.MessagesReturn(
		scenario.Message{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "call_1", Name: "run_sql", Arguments: `{"sql":"SELECT 1"}`}}},
		scenario.AssistantMsg("The answer is 1."),
	), nil
}

type mockUser struct{}

func (mockUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }
func (mockUser) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.TextReturn("What is one?"), nil
}

type passingJudge struct{}

func (passingJudge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }
func (passingJudge) Criteria() []string       { return []string{"Answers the question"} }
func (passingJudge) Call(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	if in.JudgmentRequest == nil {
		return nil, nil
	}
	return scenario.VerdictReturn(scenario.JudgeResult{Success: true, Reasoning: "All criteria passed", MetCriteria: []string{"Answers the question"}, UnmetCriteria: []string{}}), nil
}

var exactMatch = &EvaluatorSpec{
	EvaluatorID: "langevals/exact_match", Name: "Exact Match",
	Inputs:         []Input{{ID: "output", Required: true}, {ID: "expected_output", Required: true}},
	ProducesPassed: true,
}

type finishedEvents struct {
	mu   sync.Mutex
	runs []map[string]any
}

func (f *finishedEvents) listen(ev scenario.Event) {
	if ev.Type != scenario.EventRunFinished {
		return
	}
	var m map[string]any
	_ = json.Unmarshal(ev.Payload, &m)
	f.mu.Lock()
	f.runs = append(f.runs, m)
	f.mu.Unlock()
}

func runScenario(t *testing.T, api *fakeAPI, evaluators ...scenario.ScenarioEvaluator) (*scenario.ScenarioResult, map[string]any) {
	t.Helper()
	events := &finishedEvents{}
	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "chargebacks", Description: "A user asks what one is",
		Agents:          []scenario.AgentAdapter{sqlAgent{}, mockUser{}, passingJudge{}},
		Fields:          map[string]scenario.FieldValue{"golden_sql": "SELECT 1"},
		Evaluators:      evaluators,
		EvaluatorRunner: &Runner{NewAPI: func(scenario.LangWatchConfig) API { return api }, FetchRemoteTraces: func(context.Context, *scenario.Executor) {}},
		Script:          []scenario.ScriptStep{scenario.User("What is one?"), scenario.Agent(), scenario.Judge()},
	}, scenario.WithQuiet(), scenario.WithEventListener(events.listen))
	if err != nil {
		t.Fatal(err)
	}
	if len(events.runs) != 1 {
		t.Fatalf("finished events %d", len(events.runs))
	}
	return res, events.runs[0]
}

func TestScenarioCarriesEvaluations(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"langevals/exact_match": exactMatch},
		response: &EvaluateResponse{Status: "processed", Passed: ptr(true), Details: ptr("Match")}}
	res, finished := runScenario(t, api, Evaluator("langevals/exact_match",
		Map("output", Trace.ToolCalls("run_sql").Last.Input),
		Map("expected_output", Field("golden_sql")),
	))
	if body := string(requestBody(api.evaluateCalls()[0])); !strings.HasPrefix(body, `{"data":{"output":{"sql":"SELECT 1"},"expected_output":"SELECT 1"}`) {
		t.Errorf("body %s", body)
	}
	results := finished["results"].(map[string]any)
	got, _ := json.Marshal(results["evaluations"])
	want := `[{"details":"Match","evaluatorId":"langevals/exact_match","inputs":{"expected_output":"SELECT 1","output":"{\"sql\":\"SELECT 1\"}"},"name":"Exact Match","passed":true,"required":true,"status":"passed"}]`
	if string(got) != want {
		t.Errorf("evaluations\n%s\nwant\n%s", got, want)
	}
	if !res.Success || len(res.Evaluations) != 1 || results["verdict"] != "success" {
		t.Errorf("result %+v verdict %v", res, results["verdict"])
	}
}

func TestScenarioFailsOnRequiredEvaluator(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"langevals/exact_match": exactMatch},
		response: &EvaluateResponse{Status: "processed", Passed: ptr(false), Details: ptr("No match")}}
	res, finished := runScenario(t, api, Evaluator("langevals/exact_match",
		Map("output", Trace.ToolCalls("run_sql").Last.Input), Map("expected_output", Field("golden_sql"))))
	if res.Success || !strings.Contains(res.Reasoning, "Evaluator Exact Match failed: No match") {
		t.Errorf("result %+v", res)
	}
	results := finished["results"].(map[string]any)
	if finished["status"] != "FAILED" || results["verdict"] != "failure" {
		t.Errorf("finished %v", finished)
	}
}

func TestScenarioMixedEvaluations(t *testing.T) {
	api := &fakeAPI{specs: map[string]*EvaluatorSpec{"langevals/exact_match": exactMatch},
		response: &EvaluateResponse{Status: "processed", Passed: ptr(true), Details: ptr("Match")}}
	res, _ := runScenario(t, api,
		Evaluator("langevals/exact_match", Map("output", Trace.ToolCalls("run_sql").Last.Input)),
		Evaluator("langevals/exact_match", Map("output", Trace.ToolCalls("lookup").Last.Input)),
		Evaluator("langevals/exact_match", Map("output", func(*scenario.ExecutionState) any { panic("no SQL found") })),
	)
	var statuses []scenario.EvaluationStatus
	for _, e := range res.Evaluations {
		statuses = append(statuses, e.Status)
	}
	if len(statuses) != 3 || statuses[0] != scenario.EvaluationPassed || statuses[1] != scenario.EvaluationSkipped || statuses[2] != scenario.EvaluationError {
		t.Fatalf("statuses %v", statuses)
	}
	if res.Evaluations[1].Details != "no lookup call in the trace" || res.Evaluations[2].Details != "Mapping of output failed: no SQL found" {
		t.Errorf("details %q %q", res.Evaluations[1].Details, res.Evaluations[2].Details)
	}
	if len(api.evaluateCalls()) != 1 || res.Success || !strings.Contains(res.Reasoning, "Evaluator Exact Match could not run: Mapping of output failed") {
		t.Errorf("result %+v", res)
	}
}

func TestScenarioWithoutEvaluators(t *testing.T) {
	api := &fakeAPI{}
	res, finished := runScenario(t, api)
	if _, ok := finished["results"].(map[string]any)["evaluations"]; ok || res.Evaluations != nil || len(api.evaluateCalls()) != 0 {
		t.Errorf("unexpected evaluations: %v", finished)
	}
}
