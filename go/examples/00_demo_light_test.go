// Example: Demo, Lightweight Scenarios
//
// A short image-understanding check for demo runs: the user sends an image
// with a question and the judge checks the agent describes it.
//
// Mirrors: javascript/examples/vitest/tests/00-demo-light.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestDemoLight_DescribeImage(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	imageMessage := scenario.Message{
		Role: scenario.RoleUser,
		Parts: []scenario.Part{
			scenario.TextPart("What is shown here?"),
			scenario.ImagePart("image/webp", fixtureImage(t)),
		},
	}

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "demo image description",
		Description: "Simple image understanding check for demo runs",
		Agents: []scenario.AgentAdapter{
			simpleAgent("You can analyze images and respond briefly and helpfully.", nil, nil),
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria: []string{
					"Agent acknowledges the image",
					"Agent provides a short description",
				},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.MessageStep(imageMessage),
			scenario.Agent(),
			scenario.Judge(),
		},
		SetID: "scenarios-github",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
