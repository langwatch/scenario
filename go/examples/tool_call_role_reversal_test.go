// Example: Tool Call Role Reversal
//
// The agent's turn ends on a tool call and its result; the user simulator,
// which sees the conversation with roles reversed, must still be able to
// answer it (providers reject tool calls on user messages).
//
// Mirrors: javascript/examples/vitest/tests/tool-call-role-reversal.test.ts
package examples

import (
	"context"
	"encoding/json"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestToolCallRoleReversal(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	lookupTool := scenario.ToolDefinition{
		Name:        "lookup_product",
		Description: "Look up a product by name",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"product": map[string]any{
					"type":        "string",
					"description": "The product name to look up",
				},
			},
			"required":             []string{"product"},
			"additionalProperties": false,
		},
		Strict: true,
	}
	lookup := func(tc scenario.ToolCall) (string, error) {
		var args struct {
			Product string `json:"product"`
		}
		if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
			return "", err
		}
		return args.Product + ": $29.99, in stock, ships in 2 days.", nil
	}

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "tool call then user sim (gpt-4.1-mini)",
		Description: "User asks about a product, agent uses tool, then user simulator responds",
		Agents: []scenario.AgentAdapter{
			singleToolCallAgent(
				"You are a helpful shopping assistant. Always use the lookup tool to check product details before responding.",
				lookupTool, lookup,
			),
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria:    []string{"Agent used the lookup tool and provided product info"},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("do you have wireless headphones in stock?"),
			scenario.Agent(),
			scenario.User(), // the user simulator must cope with the tool call here
			scenario.Agent(),
			scenario.Judge(),
		},
		SetID: "go-examples",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
