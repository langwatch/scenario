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
	// Run reports the error and also returns the error result it sent to
	// LangWatch, like the JS SDK rejecting run() after RUN_FINISHED.
	if err == nil || !strings.Contains(err.Error(), "simulated agent failure") {
		t.Fatalf("expected the agent error, got: %v", err)
	}
	if result.Success || !strings.Contains(result.Error, "simulated agent failure") {
		t.Fatalf("expected the error in result.Error, got: %q", result.Error)
	}
}
