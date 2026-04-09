// Example: Simple Tool Mocking
//
// Demonstrates mocking a tool's execution to control its behavior,
// then verifying the agent called the tool with correct parameters.
//
// Mirrors: javascript/examples/vitest/tests/simple-tool-mocking.test.ts
package examples

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestSimpleToolMocking(t *testing.T) {
	llm := newLLM()

	// Track mock calls
	var mu sync.Mutex
	var mockCalls []map[string]string

	fetchUserDataTool := scenario.ToolDefinition{
		Name:        "fetch_user_data",
		Description: "Fetch user data from external API",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"user_id": map[string]any{
					"type":        "string",
					"description": "The user ID to fetch data for",
				},
			},
			"required":             []string{"user_id"},
			"additionalProperties": false,
		},
		Strict: true,
	}

	agent := simpleAgent(
		"You are a helpful assistant. Use the fetch_user_data tool when asked about user information.",
		[]scenario.ToolDefinition{fetchUserDataTool},
		func(tc scenario.ToolCall) (string, error) {
			var args map[string]string
			json.Unmarshal([]byte(tc.Arguments), &args)

			mu.Lock()
			mockCalls = append(mockCalls, args)
			mu.Unlock()

			// Return mocked data
			result, _ := json.Marshal(map[string]any{
				"name":   "Alice",
				"points": 150,
				"email":  "alice@example.com",
			})
			return string(result), nil
		},
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "user data tool test",
		Description: "Test agent's ability to fetch user data via tool",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Show me user data for ID 123"),
			scenario.Agent(),
			func(_ context.Context, _ scenario.Execution, _ scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				mu.Lock()
				defer mu.Unlock()

				if len(mockCalls) == 0 {
					t.Fatal("expected fetch_user_data to be called")
				}
				if mockCalls[0]["user_id"] != "123" {
					t.Fatalf("expected user_id=123, got: %s", mockCalls[0]["user_id"])
				}
				return nil, nil
			},
			scenario.Succeed("Agent called the tool with correct parameters."),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
