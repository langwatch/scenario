package scenario

import (
	"context"

	"github.com/openai/openai-go"
)

type AgentRole string
type AgentReturnKind int

const (
	AgentRoleAgent AgentRole = "agent"
	AgentRoleUser  AgentRole = "user"
	AgentRoleJudge AgentRole = "judge"

	AgentReturnString AgentReturnKind = iota
	AgentReturnScenarioResult
	AgentReturnMessages
	AgentReturnMessage
)

type AgentConfig struct {
	Name        string
	Model       string
	Temperature *float64
	MaxTokens   *int64
}

type AgentInput struct {
	ThreadID        string
	Messages        []openai.ChatCompletionMessageParamUnion
	NewMessages     []openai.ChatCompletionMessageParamUnion
	RequestedRole   AgentRole
	JudgmentRequest bool
	ScenarioState   ExecutionState
	ScenarioConfig  ScenarioConfig
}

type AgentAdapter interface {
	Role() AgentRole
	Call(ctx context.Context, input AgentInput) (*AgentReturn, error)
}

type AgentReturn struct {
	Kind AgentReturnKind

	StringValue         string
	ScenarioResultValue ScenarioResult
	MessagesValue       []openai.ChatCompletionMessageParamUnion
	MessageValue        openai.ChatCompletionMessageParamUnion
}

func NewStringAgentReturn(s string) AgentReturn {
	return AgentReturn{Kind: AgentReturnString, StringValue: s}
}
func NewScenarioResultAgentReturn(r ScenarioResult) AgentReturn {
	return AgentReturn{Kind: AgentReturnScenarioResult, ScenarioResultValue: r}
}
func NewMessagesAgentReturn(msgs []openai.ChatCompletionMessageParamUnion) AgentReturn {
	return AgentReturn{Kind: AgentReturnMessages, MessagesValue: msgs}
}
func NewMessageAgentReturn(msg openai.ChatCompletionMessageParamUnion) AgentReturn {
	return AgentReturn{Kind: AgentReturnMessage, MessageValue: msg}
}
