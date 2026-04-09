// Example: Mocked Weather Agent Tool
//
// Demonstrates injecting hardcoded tool call and tool result messages
// into the conversation to test agent behavior without real tool execution.
//
// Mirrors: javascript/examples/vitest/tests/mocked-weather-agent-tool.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMockedWeatherAgentTool(t *testing.T) {
	llm := newLLM()

	agent := simpleAgent(
		"You are a helpful assistant that provides weather information. When you receive weather data from a tool, summarize it for the user.",
		nil, nil,
	)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "mocked tool call weather",
		Description: "Test agent behavior with pre-scripted tool call and result messages.",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
				Criteria: []string{
					"Agent summarizes the weather information from the tool result",
				},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather in Paris?"),
			// Inject a hardcoded assistant message with a tool call
			scenario.AgentMessage(scenario.Message{
				Role: scenario.MessageRoleAssistant,
				ToolCalls: []scenario.ToolCall{
					{
						ID:        "call_mock_001",
						Name:      "get_current_weather",
						Arguments: `{"city":"Paris"}`,
					},
				},
			}),
			// Inject the tool result
			scenario.MessageStep(scenario.ToolMsg("call_mock_001", `The weather in Paris is sunny with a temperature of 22°C.`)),
			// Let the agent respond to the tool result
			scenario.Agent(),
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
