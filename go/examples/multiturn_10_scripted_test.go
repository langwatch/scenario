// Example: 10-Turn Scripted Multiturn Conversation
//
// Demonstrates a fully scripted 10-turn conversation where every user
// message is hardcoded. The agent generates responses to each, and a
// judge evaluates the full conversation at the end.
//
// Mirrors: javascript/examples/vitest/tests/multiturn-10-scripted.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMultiturn10Scripted(t *testing.T) {
	llm := newLLM()

	agent := simpleAgent(
		"You are a helpful travel planning assistant. Help users plan trips, suggest destinations, provide packing tips, and answer travel questions. Be concise.",
		nil, nil,
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "10-turn travel planning",
		Description: `A user plans a week-long trip to Japan, asking about destinations,
			weather, packing, food, transport, budget, etiquette, connectivity, safety,
			and a final summary.`,
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
				Criteria: []string{
					"Agent answered all 10 user questions relevantly",
					"Agent provided specific and helpful travel advice about Japan",
					"Agent maintained context across the full conversation",
				},
			}),
		},
		Script: []scenario.ScriptStep{
			// Turn 1
			scenario.User("i want to plan a week trip to japan, where should i go"),
			scenario.Agent(),
			// Turn 2
			scenario.User("what's the weather like in tokyo in april"),
			scenario.Agent(),
			// Turn 3
			scenario.User("what should i pack for that weather"),
			scenario.Agent(),
			// Turn 4
			scenario.User("any must-try food in tokyo"),
			scenario.Agent(),
			// Turn 5
			scenario.User("how do i get around the city, trains or taxi"),
			scenario.Agent(),
			// Turn 6
			scenario.User("what's a reasonable daily budget in usd"),
			scenario.Agent(),
			// Turn 7
			scenario.User("any cultural etiquette i should know about"),
			scenario.Agent(),
			// Turn 8
			scenario.User("do i need a sim card or will wifi be enough"),
			scenario.Agent(),
			// Turn 9
			scenario.User("is it safe for solo travelers"),
			scenario.Agent(),
			// Turn 10
			scenario.User("can you give me a quick day by day itinerary for 7 days"),
			scenario.Agent(),
			// Final judge
			scenario.Judge(),
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
