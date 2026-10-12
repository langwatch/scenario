// Example: Max Turns
//
// Without a script the scenario proceeds until MaxTurns: the default cap of
// 10 turns, or the cap the scenario sets.
//
// Mirrors: javascript/examples/vitest/tests/max-turns-example.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// helloWorld answers every turn with the same text.
func helloWorld(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.TextReturn("Hello, world!"), nil
}

// maxTurnsAgents are model-free stand-ins: an agent and a user that always
// say hello, and a judge that never reaches a verdict.
func maxTurnsAgents() []scenario.AgentAdapter {
	return []scenario.AgentAdapter{
		scenario.AgentFunc(helloWorld),
		roleAgent{role: scenario.AgentRoleUser, call: helloWorld},
		roleAgent{role: scenario.AgentRoleJudge, call: func(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
			return nil, nil
		}},
	}
}

func TestMaxTurns(t *testing.T) {
	tests := []struct {
		name     string
		maxTurns int // 0 keeps the default
		want     int // one user and one agent message per turn
	}{
		{name: "default max turns", want: 2 * scenario.DefaultMaxTurns},
		{name: "max turns set to 20", maxTurns: 20, want: 40},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
				Name:        "max turns example",
				Description: "This test case is used to test the max turns functionality of the scenario library.",
				Agents:      maxTurnsAgents(),
				MaxTurns:    tt.maxTurns,
				SetID:       "go-examples",
			})
			if err != nil {
				t.Fatal(err)
			}
			if !result.ReachedMaxTurns {
				t.Fatalf("expected the run to stop at max turns: %v", result.Reasoning)
			}
			if got := len(result.Messages); got != tt.want {
				t.Fatalf("expected %d messages, got %d", tt.want, got)
			}
		})
	}
}
