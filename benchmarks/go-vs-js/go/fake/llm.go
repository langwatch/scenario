package fake

import (
	"context"
	"strconv"
	"sync/atomic"

	scenario "github.com/langwatch/scenario/go"
)

// LLM is a scenario.LLM that answers from the script. It plays the user
// simulator, the agent's model and the judge, as one model would. Make one
// per run so tool call ids restart at call_1, as on the JS side.
type LLM struct {
	calls atomic.Int64
}

// NewLLM returns a fresh scripted model.
func NewLLM() *LLM { return &LLM{} }

// Calls is the number of completions served.
func (l *LLM) Calls() int64 { return l.calls.Load() }

// Inference implements scenario.LLM.
func (l *LLM) Inference(_ context.Context, p scenario.InferenceParams) (*scenario.InferenceResult, error) {
	n := l.calls.Add(1)
	offered := func(name string) bool {
		for _, t := range p.Tools {
			if t.Name == name {
				return true
			}
		}
		return false
	}
	last := len(p.Messages) > 0 && p.Messages[len(p.Messages)-1].Role == scenario.RoleTool
	r := Decide(offered, last)
	msg := scenario.Message{Role: scenario.RoleAssistant, Content: r.Text}
	if r.ToolName != "" {
		msg.ToolCalls = []scenario.ToolCall{{ID: "call_" + strconv.FormatInt(n, 10), Name: r.ToolName, Arguments: r.ToolArgs}}
	}
	return &scenario.InferenceResult{Message: msg, Usage: &scenario.Usage{InputTokens: 10, OutputTokens: 5}}, nil
}
