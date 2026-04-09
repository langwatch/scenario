// Example: Weather Agent
//
// Demonstrates an agent with tool calling, the user simulator,
// and custom script-step assertions using HasToolCall().
//
// Mirrors: javascript/examples/vitest/tests/weather-agent.test.ts
package examples

import (
	"context"
	"encoding/json"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestWeatherAgent(t *testing.T) {
	llm := newLLM()

	weatherTool := scenario.ToolDefinition{
		Name:        "get_current_weather",
		Description: "Get the current weather in a given city.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"city": map[string]any{
					"type":        "string",
					"description": "The city to get the weather for.",
				},
			},
			"required":             []string{"city"},
			"additionalProperties": false,
		},
		Strict: true,
	}

	agent := simpleAgent(
		"You are a helpful assistant that may help the user with weather information. Do not guess the city if they don't provide it.",
		[]scenario.ToolDefinition{weatherTool},
		func(tc scenario.ToolCall) (string, error) {
			var args struct{ City string `json:"city"` }
			if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
				return "", err
			}
			return simulateWeather(args.City), nil
		},
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "checking the weather",
		Description: `The user is planning a boat trip from Barcelona to Rome today,
			and is wondering what the weather will be like.`,
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User(),
			scenario.Agent(),
			// Assert tool was called
			func(_ context.Context, exec scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				if !state.HasToolCall("get_current_weather") {
					return exec.Fail(context.Background(), "Agent did not call get_current_weather tool")
				}
				return nil, nil
			},
			scenario.Succeed("Agent called the weather tool as expected."),
		},
		SetID: "go-examples",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
