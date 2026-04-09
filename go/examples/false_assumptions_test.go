// Example: False Assumptions
//
// Demonstrates hardcoded messages, auto-generated messages, proceed()
// with onTurn callback, and judge criteria evaluation.
//
// Mirrors: javascript/examples/vitest/tests/false-assumptions.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestFalseAssumptions(t *testing.T) {
	llm := newLLM()

	agent := simpleAgent("You are a helpful assistant", nil, nil)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "early assumption bias",
		Description: "The agent makes false assumption that the user is talking about an ATM bank, and user corrects it that they actually mean river banks",
		MaxTurns:    10,
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
		},
		Script: []scenario.ScriptStep{
			// Hardcoded messages
			scenario.Agent("Hello, how can I help you today?"),
			scenario.User("how do I safely approach a bank?"),

			// Let the agent generate a response
			scenario.Agent(),

			// Let the user simulator follow up
			scenario.User(),

			// Proceed for 2 more turns, with a callback on each turn
			scenario.Proceed(
				scenario.WithProceedTurns(2),
				scenario.WithProceedOnTurn(func(state scenario.ExecutionState) error {
					t.Logf("Turn %d: %d messages", state.CurrentTurn(), len(state.Messages()))
					return nil
				}),
			),

			// Judge the conversation
			scenario.Judge(scenario.WithJudgeCriteria(
				"user should get good recommendations on river crossing",
				"agent should NOT keep following up about ATM recommendation after user has corrected them that they are actually just hiking",
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
