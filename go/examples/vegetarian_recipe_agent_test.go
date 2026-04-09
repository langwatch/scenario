// Example: Vegetarian Recipe Agent
//
// Demonstrates multi-turn conversation with judge checkpoint criteria
// at different stages of the conversation.
//
// Mirrors: javascript/examples/vitest/tests/vegetarian-recipe-agent.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestVegetarianRecipeAgent(t *testing.T) {
	llm := newLLM()

	agent := simpleAgent(
		`You are a vegetarian recipe agent.
		Given the user request, ask AT MOST ONE follow-up question,
		then provide a complete recipe. Keep your responses concise and focused.`,
		nil, nil,
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "dinner idea",
		Description: "It's saturday evening, the user is very hungry and tired, but have no money to order out, so they are looking for a recipe.",
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
			scenario.Judge(scenario.WithJudgeCriteria(
				"Agent either asks a relevant follow-up question or starts providing a recipe",
			)),
			scenario.User(),
			scenario.Agent(),
			scenario.Judge(scenario.WithJudgeCriteria(
				"Agent should not ask more than two follow-up questions",
				"Agent should generate a recipe",
				"Recipe should include a list of ingredients",
				"Recipe should include step-by-step cooking instructions",
				"Recipe should be vegetarian and not include any sort of meat",
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
