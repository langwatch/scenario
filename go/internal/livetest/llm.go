package livetest

import (
	"context"
	"fmt"
	"sync"

	scenario "github.com/langwatch/scenario/go"
)

// Meter wraps an LLM and adds up the token usage every call reports, so a
// test can assert the provider reports usage on real completions.
type Meter struct {
	LLM scenario.LLM

	mu           sync.Mutex
	calls        int
	withoutUsage int
	usage        scenario.Usage
}

// NewMeter wraps llm.
func NewMeter(llm scenario.LLM) *Meter { return &Meter{LLM: llm} }

// Inference implements scenario.LLM.
func (m *Meter) Inference(ctx context.Context, p scenario.InferenceParams) (*scenario.InferenceResult, error) {
	res, err := m.LLM.Inference(ctx, p)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if res.Usage == nil {
		m.withoutUsage++
	} else {
		m.usage.InputTokens += res.Usage.InputTokens
		m.usage.OutputTokens += res.Usage.OutputTokens
	}
	return res, nil
}

// Totals returns the number of successful calls, how many of them carried
// no usage, and the summed usage.
func (m *Meter) Totals() (calls, withoutUsage int, usage scenario.Usage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls, m.withoutUsage, m.usage
}

// ChatAgent is the agent under test of the live suites: a system prompt
// over a real LLM, with an optional tool loop. Tool calls are executed with
// Execute and their results sent back to the model, up to MaxToolRounds.
type ChatAgent struct {
	LLM    scenario.LLM
	Model  string
	System string
	Tools  []scenario.ToolDefinition
	// Execute answers one tool call; required with Tools.
	Execute func(ctx context.Context, call scenario.ToolCall) string
	// MaxToolRounds bounds the tool loop; default 3.
	MaxToolRounds int
}

// Role implements scenario.AgentAdapter.
func (a *ChatAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

// Call implements scenario.AgentAdapter. It returns the tool call messages
// it produced followed by the final answer.
func (a *ChatAgent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	rounds := a.MaxToolRounds
	if rounds <= 0 {
		rounds = 3
	}
	msgs := append([]scenario.Message{scenario.SystemMsg(a.System)}, in.Messages...)
	var produced []scenario.Message
	for round := 0; ; round++ {
		params := scenario.InferenceParams{Model: a.Model, Messages: msgs}
		if len(a.Tools) > 0 {
			// Tools stay declared on every round: some providers reject a
			// history holding tool calls without the tool definitions.
			params.Tools = a.Tools
			params.ToolChoice = &scenario.ToolChoice{Type: scenario.ToolChoiceAuto}
		}
		res, err := a.LLM.Inference(ctx, params)
		if err != nil {
			return nil, err
		}
		reply := res.Message
		reply.Role = scenario.RoleAssistant
		if len(reply.ToolCalls) == 0 || a.Execute == nil {
			produced = append(produced, scenario.AssistantMsg(reply.Text()))
			return scenario.MessagesReturn(produced...), nil
		}
		if round >= rounds {
			return nil, fmt.Errorf("agent still calling tools after %d rounds", rounds)
		}
		produced = append(produced, reply)
		msgs = append(msgs, reply)
		for _, call := range reply.ToolCalls {
			result := scenario.ToolMsg(call.ID, a.Execute(ctx, call))
			result.ToolName = call.Name
			produced = append(produced, result)
			msgs = append(msgs, result)
		}
	}
}
