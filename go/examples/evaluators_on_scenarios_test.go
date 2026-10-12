// Example: Evaluators on Scenarios
//
// LangWatch evaluators check the answer against the expected answer the
// scenario carries and the SQL the agent ran, next to the judge verdict. Each
// mapping is a function of the scenario state, the same state a script step
// reads. In Go the evaluator runner is registered once with
// scenario.Configure(scenario.WithEvaluatorRunner(evaluators.NewRunner())).
//
// Needs LANGWATCH_API_KEY (and LANGWATCH_ENDPOINT for a self-hosted platform)
// plus OPENAI_API_KEY for the user simulator and the judge.
//
// Mirrors: javascript/examples/vitest/tests/evaluators-on-scenarios.test.ts
package examples

import (
	"context"
	"os"
	"reflect"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/evaluators"
)

const (
	chargebackSQL    = "SELECT quarter, count(*) FROM chargebacks WHERE merchant = 'ACME Travel' GROUP BY quarter"
	chargebackAnswer = "ACME Travel had 12 chargebacks in 2026-Q1 and 9 in 2026-Q2."
)

// sqlAnalystAgent answers with a run_sql tool call, its result and a summary.
var sqlAnalystAgent = scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.MessagesReturn(
		scenario.Message{
			Role: scenario.RoleAssistant,
			ToolCalls: []scenario.ToolCall{{
				ID:        "call_run_sql_1",
				Name:      "run_sql",
				Arguments: `{"sql":"` + chargebackSQL + `"}`,
			}},
		},
		scenario.Message{
			Role:       scenario.RoleTool,
			ToolCallID: "call_run_sql_1",
			ToolName:   "run_sql",
			Content:    `[{"quarter":"2026-Q1","count":12},{"quarter":"2026-Q2","count":9}]`,
		},
		scenario.AssistantMsg(chargebackAnswer),
	), nil
})

func TestEvaluatorsOnScenarios(t *testing.T) {
	skipWithoutOpenAI(t)
	if os.Getenv("LANGWATCH_API_KEY") == "" {
		t.Skip("LANGWATCH_API_KEY not set")
	}

	// Once per process: the core package carries the evaluator declarations,
	// the evaluators package runs them.
	scenario.Configure(scenario.WithEvaluatorRunner(evaluators.NewRunner()))

	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-5-mini"}
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "chargeback totals by quarter",
		Description: "A fraud analyst asks for the chargebacks per quarter for merchant ACME Travel.",
		Agents: []scenario.AgentAdapter{
			sqlAnalystAgent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria:    []string{"The agent reports chargeback counts per quarter"},
			}),
		},
		Fields: map[string]scenario.FieldValue{
			"expected_answer": chargebackAnswer,
			"table_schema":    "CREATE TABLE chargebacks (id text, merchant text, quarter text)",
		},
		Evaluators: []scenario.ScenarioEvaluator{
			// Inferred mappings: output reads the last agent message and
			// expected_output reads the expected_answer field.
			evaluators.Evaluator("langevals/exact_match", evaluators.Required(true)),
			// The SQL the agent ran is the input of the last run_sql call.
			evaluators.Evaluator("langevals/llm_boolean",
				evaluators.Required(false),
				evaluators.Map("output", evaluators.Trace.ToolCalls("run_sql").Last.Input),
				evaluators.Settings(map[string]any{
					"prompt": "Does this SQL group chargebacks by quarter for one merchant? Answer true or false.",
				}),
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("How many chargebacks did ACME Travel have per quarter?"),
			scenario.Agent(),
			// A script step reads the same state the evaluator mappings read.
			scenario.StepFunc(func(_ context.Context, ex *scenario.Executor) error {
				call, ok := ex.State().ToolCalls("run_sql").Last()
				if !ok {
					return scenario.Assert(false, "the agent called run_sql")
				}
				return scenario.Assert(reflect.DeepEqual(call.Input, map[string]any{"sql": chargebackSQL}),
					"run_sql got the expected query")
			}),
			scenario.Judge(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}

	statuses := map[string]scenario.EvaluationStatus{}
	for _, e := range result.Evaluations {
		statuses[e.EvaluatorID] = e.Status
	}
	if statuses["langevals/exact_match"] != scenario.EvaluationPassed {
		t.Errorf("exact_match: %s", statuses["langevals/exact_match"])
	}
	if s := statuses["langevals/llm_boolean"]; s != scenario.EvaluationPassed && s != scenario.EvaluationFailed {
		t.Errorf("llm_boolean: %s", s)
	}
}
