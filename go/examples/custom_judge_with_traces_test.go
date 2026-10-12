// Example: Custom Judge with Traces
//
// A custom judge that reads the OpenTelemetry spans the run collected to
// check that a required tool was called, instead of trusting the agent's
// text. The agent here never calls the tool, so the judge fails the run.
//
// Mirrors: javascript/examples/vitest/tests/custom-judge-with-traces.test.ts
package examples

import (
	"context"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// toolVerifyingJudge passes the run only when a span of the run names the
// required tool.
type toolVerifyingJudge struct {
	requiredTool string
}

func (j *toolVerifyingJudge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }

func (j *toolVerifyingJudge) Call(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	if in.JudgmentRequest == nil {
		return nil, nil // not asked for a verdict yet
	}
	criterion := "Agent must call the '" + j.requiredTool + "' tool"

	// Every span of this thread, local or fetched from LangWatch. The same
	// list is scenario.DefaultSpanCollector().SpansForThread(in.ThreadID).
	for _, span := range in.ScenarioState.Spans() {
		if strings.Contains(span.Name(), j.requiredTool) {
			return scenario.VerdictReturn(scenario.JudgeResult{
				Success:     true,
				Reasoning:   "Tool '" + j.requiredTool + "' was found in span " + span.Name(),
				MetCriteria: []string{criterion},
			}), nil
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.Emit(), j.requiredTool) {
				return scenario.VerdictReturn(scenario.JudgeResult{
					Success:     true,
					Reasoning:   "Tool '" + j.requiredTool + "' was found in attribute " + string(attr.Key),
					MetCriteria: []string{criterion},
				}), nil
			}
		}
	}
	return scenario.VerdictReturn(scenario.JudgeResult{
		Success:       false,
		Reasoning:     "Tool '" + j.requiredTool + "' was not found in the trace",
		UnmetCriteria: []string{criterion},
	}), nil
}

func TestCustomJudgeWithTraces(t *testing.T) {
	skipWithoutOpenAI(t)

	agent := scenario.AgentFunc(func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("Sure! Let me look that up for you. The weather today is sunny and 72F."), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "trace-aware judge",
		Description: "User asks for weather and expects the agent to use a weather tool",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				ModelConfig: scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"},
			}),
			&toolVerifyingJudge{requiredTool: "weather_lookup"},
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather like today?"),
			scenario.Agent(),
			scenario.Judge(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// The agent emits no tool spans, so the judge reports the missing tool.
	if result.Success {
		t.Fatal("expected the judge to fail the run")
	}
	if !strings.Contains(result.Reasoning, "weather_lookup") {
		t.Errorf("reasoning does not name the tool: %s", result.Reasoning)
	}
}
