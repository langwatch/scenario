// Example: API Service Mocking
//
// Mocks the HTTP service a tool calls rather than the tool itself, so the
// test covers both the agent's tool use and the tool's implementation.
//
// Mirrors: javascript/examples/vitest/tests/api-service-mocking.test.ts
package examples

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// userService is the API client the fetch_user_data tool depends on.
type userService interface {
	GetUser(ctx context.Context, id string) (map[string]string, error)
}

// mockUserService answers with a canned user and records the ids asked for.
type mockUserService struct {
	mu    sync.Mutex
	calls []string
	user  map[string]string
}

func (s *mockUserService) GetUser(_ context.Context, id string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, id)
	return s.user, nil
}

func (s *mockUserService) calledWith(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.calls {
		if c == id {
			return true
		}
	}
	return false
}

// fetchUserData is the real tool implementation; only the service it calls
// is mocked.
func fetchUserData(ctx context.Context, api userService, call scenario.ToolCall) (string, error) {
	var args struct {
		UserID string `json:"user_id"`
	}
	if err := json.Unmarshal([]byte(call.Arguments), &args); err != nil {
		return "", err
	}
	user, err := api.GetUser(ctx, args.UserID)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(user)
	return string(out), err
}

func TestAPIServiceMocking(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	api := &mockUserService{user: map[string]string{
		"id":    "123",
		"name":  "Alice",
		"email": "alice@example.com",
	}}

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
			return fetchUserData(context.Background(), api, tc)
		},
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "api service test",
		Description: "Test tool's API integration",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Get user data for ID 123"),
			scenario.Agent(),
			// The service was called with the right id: this checks the
			// agent and the tool implementation together.
			scenario.StepFunc(func(context.Context, *scenario.Executor) error {
				return scenario.Assert(api.calledWith("123"), "expected the user service to be called with id 123")
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
