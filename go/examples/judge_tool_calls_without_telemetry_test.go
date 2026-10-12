// Example: Judge Tool Calls Without Telemetry
//
// The judge can evaluate tool calls without OpenTelemetry: the agent returns
// the assistant tool call and the tool result as messages, so they become
// part of the conversation the judge reads.
//
// Mirrors: javascript/examples/vitest/tests/judge-tool-calls-without-telemetry.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

var getWeatherTool = scenario.ToolDefinition{
	Name:        "get_weather",
	Description: "Get the current weather for a city",
	Parameters: map[string]any{
		"type":       "object",
		"properties": map[string]any{"city": map[string]any{"type": "string"}},
		"required":   []string{"city"},
	},
}

func TestJudgeToolCallsWithoutTelemetry(t *testing.T) {
	skipWithoutOpenAI(t)
	llm := newLLM()

	weatherAgent := scenario.AgentFunc(func(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
		res, err := llm.Inference(ctx, scenario.InferenceParams{
			Model:      "gpt-4.1-mini",
			Messages:   in.Messages,
			Tools:      []scenario.ToolDefinition{getWeatherTool},
			ToolChoice: &scenario.ToolChoice{Type: scenario.ToolChoiceAuto},
		})
		if err != nil {
			return nil, err
		}
		if len(res.Message.ToolCalls) == 0 {
			return scenario.TextReturn(res.Message.Content), nil
		}
		call := res.Message.ToolCalls[0]
		// Return the call and its (mocked) result so the judge sees both.
		return scenario.MessagesReturn(
			scenario.Message{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{call}},
			scenario.Message{
				Role:       scenario.RoleTool,
				ToolCallID: call.ID,
				ToolName:   call.Name,
				Content:    `{"temp":22,"condition":"sunny"}`,
			},
		), nil
	})

	model := scenario.ModelConfig{LLM: llm, Model: "gpt-4.1-mini"}
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "weather tool evaluation",
		Description: "Judge evaluates tool calls without telemetry",
		Agents: []scenario.AgentAdapter{
			weatherAgent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather in Paris?"),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"The agent called the get_weather tool with city 'Paris'",
				"The tool returned weather data",
			)),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}
}
