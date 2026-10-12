// Example: LLM Provider Mocking
//
// Replaces the model behind the agent with a canned LLM to test the
// conversation flow offline, without model calls or an API key.
//
// Mirrors: javascript/examples/vitest/tests/llm-provider-mocking.test.ts
package examples

import (
	"context"
	"sync/atomic"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// cannedLLM answers every inference with the same reply and counts calls.
type cannedLLM struct {
	reply string
	calls atomic.Int32
}

func (l *cannedLLM) Inference(context.Context, scenario.InferenceParams) (*scenario.InferenceResult, error) {
	l.calls.Add(1)
	return &scenario.InferenceResult{Message: scenario.AssistantMsg(l.reply)}, nil
}

func TestLLMProviderMocking(t *testing.T) {
	llm := &cannedLLM{reply: "I can help you with that request."}

	// The agent under test talks to whatever LLM it is given; here, the mock.
	chatAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		res, err := llm.Inference(ctx, scenario.InferenceParams{Model: "gpt-4.1-mini", Messages: input.Messages})
		if err != nil {
			return nil, err
		}
		return scenario.MessageReturn(res.Message), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "llm mock test",
		Description: "Test with mocked LLM responses",
		Agents: []scenario.AgentAdapter{
			chatAgent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				ModelConfig: scenario.ModelConfig{LLM: llm, Model: "gpt-4.1-mini"},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello"),
			scenario.Agent(),
			scenario.StepFunc(func(_ context.Context, ex *scenario.Executor) error {
				if err := scenario.Assert(llm.calls.Load() > 0, "expected the mocked LLM to be called"); err != nil {
					return err
				}
				msg, err := ex.State().LastAgentMessage()
				if err != nil {
					return err
				}
				return scenario.Assert(msg.Content == "I can help you with that request.",
					"expected the canned reply, got: "+msg.Content)
			}),
			scenario.Succeed(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
