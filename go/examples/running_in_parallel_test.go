// Example: Running in Parallel
//
// Runs independent scenarios concurrently with t.Parallel(); runs share
// nothing but the agent under test.
//
// Mirrors: javascript/examples/vitest/tests/running-in-parallel.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestRunningInParallel(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	agent := simpleAgent(`You are a vegetarian recipe agent. When a user asks for a recipe,
<rules>
  - You may ask ONLY ONE clarifying question if absolutely necessary (like dietary restrictions or cooking time preference), but then you MUST provide a complete vegetarian recipe.
  - Do not ask multiple follow-up questions.
</rules>`, nil, nil)

	criteria := []string{
		"Recipe agent generates a vegetarian recipe",
		"Recipe includes a list of ingredients",
		"Recipe includes step-by-step cooking instructions",
		"The recipe is vegetarian and does not include meat",
		"The agent should NOT ask more than two follow-up questions",
	}

	tests := []struct{ name, description string }{
		{name: "dinner idea", description: "User is looking for a dinner idea"},
		{name: "hungry user", description: "User is very very hungry, they say they could eat a cow"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
				Name:        tt.name,
				Description: tt.description,
				Agents: []scenario.AgentAdapter{
					agent,
					scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
					scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model, Criteria: criteria}),
				},
				MaxTurns: 5,
				SetID:    "go-examples",
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
