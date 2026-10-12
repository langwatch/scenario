//go:build integration

package evaluators_test

import (
	"context"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/evaluators"
	"github.com/langwatch/scenario/go/internal/livetest"
)

// exactMatch is the built-in evaluator of the live checks: it runs on the
// LangWatch side without an LLM, so it costs nothing.
const exactMatch = "langevals/exact_match"

// TestLiveEvaluatorsAPI reads the evaluator catalogue and runs one
// evaluation against the real LangWatch evaluations API. Needs
// LANGWATCH_API_KEY.
func TestLiveEvaluatorsAPI(t *testing.T) {
	lw := livetest.RequireLangWatch(t)
	ctx := livetest.Context(t, 2*time.Minute)
	client := evaluators.NewClient(lw.Config, evaluators.ClientOptions{})

	spec, err := client.EvaluatorSpec(ctx, exactMatch)
	if err != nil {
		t.Fatal(err)
	}
	if spec == nil {
		t.Fatalf("%s is not in the catalogue", exactMatch)
	}
	inputs := map[string]bool{}
	for _, in := range spec.Inputs {
		inputs[in.ID] = true
	}
	if !inputs["output"] || !inputs["expected_output"] || !spec.ProducesPassed {
		t.Fatalf("spec %+v, want output and expected_output inputs and a pass/fail verdict", spec)
	}

	for _, tc := range []struct {
		output, expected string
		passed           bool
	}{
		{"Paris", "Paris", true},
		{"Lyon", "Paris", false},
	} {
		res, err := client.Evaluate(ctx, evaluators.EvaluateRequest{
			EvaluatorRef: exactMatch,
			Data:         map[string]any{"output": tc.output, "expected_output": tc.expected},
			Order:        []string{"output", "expected_output"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != "processed" || res.Passed == nil || *res.Passed != tc.passed {
			t.Errorf("%q vs %q: %+v, want processed passed=%v", tc.output, tc.expected, res, tc.passed)
		}
	}
}

// TestLiveScenarioEvaluatorsReachLangWatch is the port of the JavaScript
// evaluators-on-scenarios example without an LLM: a scripted agent answers,
// two exact-match evaluators check the answer against the expected answer
// the scenario carries (one required and passing, one optional and
// failing), and the run read back from LangWatch carries both results.
// Needs LANGWATCH_API_KEY.
func TestLiveScenarioEvaluatorsReachLangWatch(t *testing.T) {
	lw := livetest.RequireLangWatch(t)
	ctx := livetest.Context(t, 3*time.Minute)
	const answer = "ACME Travel had 12 chargebacks in 2026-Q1."
	lastAnswer := func(s *scenario.ExecutionState) any {
		m, err := s.LastAgentMessage()
		if err != nil {
			return nil
		}
		return m.Text()
	}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live: evaluators on scenarios",
		Description: "A finance analyst asks how many chargebacks ACME Travel had in 2026-Q1.",
		Agents: []scenario.AgentAdapter{scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
			return scenario.TextReturn(answer), nil
		})},
		Fields: map[string]scenario.FieldValue{"expected_answer": answer},
		Evaluators: []scenario.ScenarioEvaluator{
			evaluators.Evaluator(exactMatch,
				evaluators.Map("output", lastAnswer),
				evaluators.Map("expected_output", evaluators.Field("expected_answer"))),
			evaluators.Evaluator(exactMatch, evaluators.Required(false),
				evaluators.Map("output", lastAnswer),
				evaluators.Map("expected_output", "a different answer")),
		},
		EvaluatorRunner: evaluators.NewRunner(),
		Script: []scenario.ScriptStep{
			scenario.User("How many chargebacks did ACME Travel have in 2026-Q1?"),
			scenario.Agent(),
			scenario.Succeed("scripted"),
		},
		SetID: livetest.SetID,
	}, scenario.WithLangWatch(lw.Config))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Success {
		t.Fatalf("an optional failing evaluator must not fail the run: %s", res.Reasoning)
	}
	if len(res.Evaluations) != 2 {
		t.Fatalf("evaluations %+v, want 2", res.Evaluations)
	}
	if e := res.Evaluations[0]; e.Status != scenario.EvaluationPassed || !e.Required {
		t.Errorf("required evaluator: %+v", e)
	}
	if e := res.Evaluations[1]; e.Status != scenario.EvaluationFailed || e.Required {
		t.Errorf("optional evaluator: %+v", e)
	}

	run := lw.WaitSimulationRun(t, ctx, res.RunID, func(r *livetest.SimulationRun) bool {
		return livetest.Finished(r) && len(r.Results.Evaluations) == 2
	})
	got := run.Results.Evaluations
	if got[0].Status != "passed" || !got[0].Required || got[1].Status != "failed" || got[1].Required {
		t.Errorf("evaluations in LangWatch: %+v", got)
	}
}
