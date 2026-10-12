// Example: Multimodal Images
//
// Sends an image, alone or with a text question, as a user message and
// judges how the agent analyzes it.
//
// Mirrors: javascript/examples/vitest/tests/multimodal-images.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMultimodalImages(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	image := scenario.ImagePart("image/webp", fixtureImage(t))

	imageAgent := simpleAgent(`You are a helpful assistant that can process both text and image input.
When analyzing images, be descriptive and helpful.
Respond naturally to user queries about images.`, nil, nil)

	tests := []struct {
		name        string
		description string
		parts       []scenario.Part
		criteria    []string
	}{
		{
			name:        "multimodal image analysis",
			description: "User sends both text and image, agent analyzes the image content",
			parts:       []scenario.Part{scenario.TextPart("What do you see in this image?"), image},
			criteria: []string{
				"Agent acknowledges the image input",
				"Agent provides a descriptive analysis of the image",
				"Agent responds appropriately to the text question",
				"Agent demonstrates understanding of the multimodal input",
			},
		},
		{
			name:        "image-only analysis",
			description: "User sends only an image, agent provides analysis",
			parts:       []scenario.Part{image},
			criteria: []string{
				"Agent recognizes the image input",
				"Agent provides meaningful analysis without text prompt",
				"Agent demonstrates image understanding capabilities",
			},
		},
		{
			name:        "complex image analysis",
			description: "User asks for detailed analysis of image elements",
			parts: []scenario.Part{
				scenario.TextPart("Analyze this image and tell me what colors are present, what shapes you see, and what this might represent."),
				image,
			},
			criteria: []string{
				"Agent identifies colors in the image",
				"Agent recognizes shapes present",
				"Agent provides interpretation of the image content",
				"Agent addresses all aspects of the complex query",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
				Name:        tt.name,
				Description: tt.description,
				Agents: []scenario.AgentAdapter{
					imageAgent,
					scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
					scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
				},
				Script: []scenario.ScriptStep{
					scenario.MessageStep(scenario.Message{Role: scenario.RoleUser, Parts: tt.parts}),
					scenario.Agent(),
					scenario.Judge(scenario.WithCriteria(tt.criteria...)),
				},
				SetID: "multimodal-images-test",
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
