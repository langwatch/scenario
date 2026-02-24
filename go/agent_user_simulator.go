package scenario

import (
	"context"
	"errors"
	"strings"

	"github.com/langwatch/scenario/go/internal/libraries/ptr"
)

const userSimulatorPrompt = `
<role>
You are pretending to be a user, you are testing an AI Agent (shown as the user role) based on a scenario.
Approach this naturally, as a human user would, with very short inputs, few words, all lowercase, imperative, not periods, like when they google or talk to chatgpt.
</role>

<goal>
Your goal (assistant) is to interact with the Agent Under Test (user) as if you were a human user to see if it can complete the scenario successfully.
</goal>

<scenario>
{{.Description}}
</scenario>

<rules>
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user
</rules>
`

func buildUserSimulatorPrompt(description string) string {
	// NOTE(afr): Change this to a template
	return strings.ReplaceAll(userSimulatorPrompt, "{{.Description}}", description)
}

type UserSimulatorAgentConfig struct {
	AgentConfig

	SystemPrompt *string
}

type UserSimulatorAgent struct {
	cfg UserSimulatorAgentConfig
}

func NewUserSimulatorAgent(cfg UserSimulatorAgentConfig) *UserSimulatorAgent {
	return &UserSimulatorAgent{
		cfg: cfg,
	}
}

func (a *UserSimulatorAgent) Role() AgentRole {
	return AgentRoleUser
}

func (a *UserSimulatorAgent) Call(ctx context.Context, input AgentInput) (*AgentReturn, error) {
	var systemPrompt string
	if a.cfg.SystemPrompt != nil {
		systemPrompt = *a.cfg.SystemPrompt
	} else {
		systemPrompt = buildUserSimulatorPrompt(input.ScenarioConfig.Description)
	}

	messages := []Message{
		SystemMsg(systemPrompt),
	}
	messages = append(messages, input.Messages...)

	// Role reversal: swap user<->assistant before calling LLM
	// LLM models are biased to always be the assistant not the user
	reversedMessages := messageRoleReversal(messages)

	params := InferenceParams{
		Model:       a.cfg.Model,
		Messages:    reversedMessages,
		Temperature: ptr.Ptr(ptr.ValueOrDefault(a.cfg.Temperature, 0.0)),
	}
	if a.cfg.MaxTokens != nil {
		params.MaxTokens = a.cfg.MaxTokens
	}

	result, err := a.cfg.LLM.Inference(ctx, params)
	if err != nil {
		return nil, err
	}

	if result.Message.Content == "" && len(result.Message.ToolCalls) == 0 {
		return nil, errors.New("user simulator agent had no response content")
	}

	// Return as a user message string (the LLM generated as assistant, but we want it as user)
	return NewStringAgentReturn(result.Message.Content), nil
}
