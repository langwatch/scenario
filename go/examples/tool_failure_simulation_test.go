// Example: Tool Failure Simulation
//
// Runs the agent's tool by hand so a failing tool becomes an error result the
// model can report, instead of a crash; covers the failure and success paths.
//
// Mirrors: javascript/examples/vitest/tests/tool-failure-simulation.test.ts
package examples

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestToolFailureSimulation(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	serviceTool := scenario.ToolDefinition{
		Name:        "call_external_service",
		Description: "Call an external service API endpoint",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"endpoint": map[string]any{"type": "string"},
			},
			"required":             []string{"endpoint"},
			"additionalProperties": false,
		},
		Strict: true,
	}

	tests := []struct {
		name        string
		description string
		// service stands in for the external service the tool calls.
		service func() (string, error)
	}{
		{
			name:        "tool failure test",
			description: "Test that agent handles tool failures without crashing",
			service:     func() (string, error) { return "", errors.New("request timeout") },
		},
		{
			name:        "tool success test",
			description: "Test that agent handles successful tool calls",
			service:     func() (string, error) { return "Success", nil },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int32
			agent := singleToolCallAgent("You are a helpful assistant.", serviceTool, func(scenario.ToolCall) (string, error) {
				calls.Add(1)
				return tt.service()
			})

			result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
				Name:        tt.name,
				Description: tt.description,
				Agents: []scenario.AgentAdapter{
					agent,
					scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
				},
				Script: []scenario.ScriptStep{
					scenario.User("Call the service at /api/data"),
					scenario.Agent(),
					// The model chose the tool, and its outcome landed in the
					// conversation as a tool result rather than an error.
					scenario.StepFunc(func(_ context.Context, ex *scenario.Executor) error {
						if err := scenario.Assert(calls.Load() > 0, "expected the external service to be called"); err != nil {
							return err
						}
						return scenario.Assert(ex.State().HasToolCall("call_external_service"),
							"expected a call_external_service tool call in the conversation")
					}),
					scenario.Succeed(),
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			if !result.Success {
				t.Fatalf("scenario failed: %v", result.Reasoning)
			}
		})
	}
}
