package fake

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
)

// orderTool is the tool definition the agent offers its model.
var orderTool = scenario.ToolDefinition{
	Name:        OrderTool,
	Description: "Look up the shipping status of an order.",
	Parameters: map[string]any{
		"type":                 "object",
		"properties":           map[string]any{"order_id": map[string]any{"type": "string"}},
		"required":             []any{"order_id"},
		"additionalProperties": false,
	},
}

// Agent is the agent under test: per turn it asks its model, runs the
// get_order_status tool the model calls, and asks again for the answer. It
// returns the three messages (tool call, tool result, answer), like the
// JS agent's generateText with one tool step.
type Agent struct {
	LLM scenario.LLM
}

// Role implements scenario.AgentAdapter.
func (a *Agent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

// Name implements scenario.Named.
func (a *Agent) Name() string { return "OrderAgent" }

// Call implements scenario.AgentAdapter.
func (a *Agent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	tools := []scenario.ToolDefinition{orderTool}
	first, err := a.LLM.Inference(ctx, scenario.InferenceParams{Model: ModelName, Messages: in.Messages, Tools: tools})
	if err != nil {
		return nil, err
	}
	if len(first.Message.ToolCalls) == 0 {
		return nil, errors.New("fake agent: expected a tool call")
	}
	call := first.Message.ToolCalls[0]
	result := scenario.ToolMsg(call.ID, OrderResult)
	result.ToolName = call.Name

	msgs := make([]scenario.Message, 0, len(in.Messages)+2)
	msgs = append(msgs, in.Messages...)
	msgs = append(msgs, first.Message, result)
	second, err := a.LLM.Inference(ctx, scenario.InferenceParams{Model: ModelName, Messages: msgs, Tools: tools})
	if err != nil {
		return nil, err
	}
	return scenario.MessagesReturn(first.Message, result, second.Message), nil
}

// EchoAgent answers every turn with fixed text, without a model. The cold
// start scenario uses it.
type EchoAgent struct{}

// Role implements scenario.AgentAdapter.
func (EchoAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

// Call implements scenario.AgentAdapter.
func (EchoAgent) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.TextReturn(AgentText), nil
}
