// Example: Travel Agent
//
// Demonstrates a multi-tool agent with recursive tool execution,
// tool-call assertions at multiple points, and judge criteria.
//
// Mirrors: javascript/examples/vitest/tests/travel-agent.test.ts
package examples

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestTravelAgent(t *testing.T) {
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
				"date_range": map[string]any{
					"type":        "string",
					"description": "The date range to get the weather for.",
				},
			},
			"required":             []string{"city", "date_range"},
			"additionalProperties": false,
		},
		Strict: true,
	}

	accommodationTool := scenario.ToolDefinition{
		Name:        "get_accommodation",
		Description: "Get accommodation options in a given city.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"city": map[string]any{
					"type":        "string",
					"description": "The city to get the accommodation for.",
				},
				"weather": map[string]any{
					"type":        "string",
					"enum":        []string{"sunny", "cloudy", "rainy", "snowy"},
					"description": "The weather in the city.",
				},
			},
			"required":             []string{"city", "weather"},
			"additionalProperties": false,
		},
		Strict: true,
	}

	tools := []scenario.ToolDefinition{weatherTool, accommodationTool}

	executor := func(tc scenario.ToolCall) (string, error) {
		switch tc.Name {
		case "get_current_weather":
			var args struct{ City string `json:"city"` }
			json.Unmarshal([]byte(tc.Arguments), &args)
			return simulateWeather(args.City), nil

		case "get_accommodation":
			var args struct {
				City    string `json:"city"`
				Weather string `json:"weather"`
			}
			json.Unmarshal([]byte(tc.Arguments), &args)

			options := map[string][]string{
				"sunny":  {"Water Park Inn - $100/night", "Beach Resort La Playa - $150/night", "Hotelito - $200/night"},
				"cloudy": {"Hotel Barcelona - $100/night", "Hotel Rome - $150/night", "Hotel Venice - $200/night"},
				"rainy":  {"Hotel Barcelona - $100/night", "Hotel Rome - $150/night", "Hotel Venice - $200/night"},
				"snowy":  {"Mountains Peak Lodge - $100/night", "Snowy Mountain Inn - $150/night", "Snowy Mountain Resort - $200/night"},
			}
			accom, ok := options[args.Weather]
			if !ok {
				// Pick random weather-appropriate options
				weathers := []string{"sunny", "cloudy", "rainy", "snowy"}
				accom = options[weathers[rand.Intn(len(weathers))]]
			}
			result, _ := json.Marshal(accom)
			return string(result), nil

		default:
			return "", fmt.Errorf("unknown tool: %s", tc.Name)
		}
	}

	agent := simpleAgent(
		`You are a helpful travel agent that helps the user with weather information and accommodation options, use the tools provided to you.
		Do not guess the city if they don't provide it.
		You can make multiple tool calls if they ask multiple cities.
		You may ask at most one clarifying question. After that, make reasonable assumptions and proceed with tool calls and recommendations.
		Today is Friday, 25th July 2025.`,
		tools,
		executor,
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "boat trip travel planning",
		Description: `The user is planning a boat trip from Barcelona to Rome,
			and is wondering what the weather will be like.
			Then the user will ask for different accommodation options.`,
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User(),
			scenario.Agent(),
			scenario.User(),
			scenario.Agent(),
			func(_ context.Context, exec scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				if !state.HasToolCall("get_current_weather") {
					return exec.Fail(context.Background(), "Agent did not call get_current_weather")
				}
				return nil, nil
			},
			scenario.User(),
			scenario.Agent(),
			func(_ context.Context, exec scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				if !state.HasToolCall("get_accommodation") {
					return exec.Fail(context.Background(), "Agent did not call get_accommodation")
				}
				return nil, nil
			},
			scenario.Judge(scenario.WithJudgeCriteria(
				"The agent should ask which city is the user asking accommodations for if they don't provide it.",
				"The agent should share the prices of each accommodation for the user to consider.",
				"The agent should not bias the user towards a specific accommodation.",
			)),
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
