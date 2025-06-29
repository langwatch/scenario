package scenario

import (
	"context"
	"errors"
	"strings"

	"github.com/langwatch/scenario/go/internal/libraries/ptr"

	"github.com/openai/openai-go"
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

type UserSimulatorAgent struct {
	cfg AgentConfig
	llm *openai.Client
}

func NewUserSimulatorAgent(cfg AgentConfig) *UserSimulatorAgent {
	// setup openai client, set based on

	return &UserSimulatorAgent{cfg: cfg}
}

func (a *UserSimulatorAgent) Call(ctx context.Context, input AgentInput) (*AgentReturn, error) {
	systemPrompt := buildUserSimulatorPrompt(input.ScenarioConfig.Description)
	messages := append(input.Messages, openai.SystemMessage(systemPrompt))

	params := openai.ChatCompletionNewParams{
		Messages:    messages,
		Model:       a.cfg.Model,
		Temperature: openai.Opt(ptr.ValueOrDefault(a.cfg.Temperature, 0.0)),
	}
	if a.cfg.MaxTokens != nil {
		params.MaxCompletionTokens = openai.Opt(*a.cfg.MaxTokens)
	}

	completion, err := a.llm.Chat.Completions.New(ctx, params)
	if err != nil {
		return nil, err
	}

	if len(completion.Choices) == 0 {
		return nil, errors.New("user simulator agent had no response choices")
	}

	return NewMessageAgentReturn(openai.ChatCompletionMessageParamUnion{
		OfAssistant: ptr.Ptr(completion.Choices[0].Message.ToAssistantMessageParam()),
	}), nil
}
