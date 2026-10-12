package scenario

import (
	"context"
	"errors"
	"testing"
)

// An LLM that reports neither a result nor an error fails the call instead
// of panicking the agent that dereferences the result.
func TestInvokerRejectsNilResult(t *testing.T) {
	t.Parallel()
	llm := &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return nil, nil }}
	var iv invoker
	if _, err := iv.invoke(context.Background(), llm, InferenceParams{}); !errors.Is(err, errNilInference) {
		t.Fatalf("invoke error = %v, want errNilInference", err)
	}
	sim := NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}})
	if _, err := sim.Call(context.Background(), AgentInput{}); !errors.Is(err, errNilInference) {
		t.Fatalf("user simulator error = %v, want errNilInference", err)
	}
}
