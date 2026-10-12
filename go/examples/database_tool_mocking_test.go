// Example: Database Tool Mocking
//
// Mocks several database tools (save, find) of one agent and checks the
// agent passed the right parameters, with no database involved.
//
// Mirrors: javascript/examples/vitest/tests/database-tool-mocking.test.ts
package examples

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestDatabaseToolMocking_SaveUser(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	// The arguments each mocked database tool was called with.
	var mu sync.Mutex
	calls := map[string][]map[string]string{}

	stringParams := func(fields map[string]string) map[string]any {
		props := map[string]any{}
		required := make([]string, 0, len(fields))
		for name, desc := range fields {
			props[name] = map[string]any{"type": "string", "description": desc}
			required = append(required, name)
		}
		return map[string]any{
			"type":                 "object",
			"properties":           props,
			"required":             required,
			"additionalProperties": false,
		}
	}
	tools := []scenario.ToolDefinition{
		{
			Name:        "save_user",
			Description: "Save a user to the database",
			Parameters:  stringParams(map[string]string{"name": "The user's name", "email": "The user's email"}),
			Strict:      true,
		},
		{
			Name:        "find_user",
			Description: "Find users by name",
			Parameters:  stringParams(map[string]string{"name": "The name to search for"}),
			Strict:      true,
		},
	}

	agent := simpleAgent(
		"You manage the user database. Use the database tools to save and find users.",
		tools,
		func(tc scenario.ToolCall) (string, error) {
			var args map[string]string
			if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
				return "", err
			}
			mu.Lock()
			calls[tc.Name] = append(calls[tc.Name], args)
			mu.Unlock()

			switch tc.Name {
			case "save_user":
				return `{"id":123,"name":"John","email":"john@example.com"}`, nil
			case "find_user":
				return `[]`, nil
			}
			return "", fmt.Errorf("unknown tool %q", tc.Name)
		},
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "database save test",
		Description: "Test agent's ability to save user data via tool",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Save a new user named John with email john@example.com"),
			scenario.Agent(),
			// The agent extracted the name and email from the user's message.
			scenario.StepFunc(func(context.Context, *scenario.Executor) error {
				mu.Lock()
				defer mu.Unlock()
				saves := calls["save_user"]
				if err := scenario.Assert(len(saves) > 0, "expected save_user to be called"); err != nil {
					return err
				}
				got := saves[0]
				return scenario.Assert(got["name"] == "John" && got["email"] == "john@example.com",
					fmt.Sprintf("expected save_user(name=John, email=john@example.com), got %v", got))
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
}
