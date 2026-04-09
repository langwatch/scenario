// Example: Error Handling
//
// Demonstrates how scenario errors are propagated when agents fail.
package examples

import (
	"context"
	"errors"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

type errorAgent struct{}

func (a *errorAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *errorAgent) Call(_ context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, errors.New("simulated agent failure")
}

func TestErrorHandling_AgentError(t *testing.T) {
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "error scenario",
		Description: "This scenario is designed to fail due to an agent error.",
		Agents:      []scenario.AgentAdapter{&errorAgent{}, &dummyUserAgent{}},
		Script: []scenario.ScriptStep{
			scenario.User("Hello"),
			scenario.Agent(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The Go SDK wraps agent errors into a failed ScenarioResult
	// rather than returning an error from Run().
	if result.Success {
		t.Fatal("expected scenario to fail")
	}
	if result.Error == nil || !strings.Contains(*result.Error, "simulated agent failure") {
		t.Fatalf("expected 'simulated agent failure' in result.Error, got: %v", result.Error)
	}
}
