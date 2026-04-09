package scenario

import (
	"context"
)

type AgentRole string
type AgentReturnKind int

const (
	AgentRoleAgent AgentRole = "Agent"
	AgentRoleUser  AgentRole = "User"
	AgentRoleJudge AgentRole = "Judge"

	AgentReturnString AgentReturnKind = iota
	AgentReturnScenarioResult
	AgentReturnMessages
	AgentReturnMessage
)

type AgentConfig struct {
	Name string

	Model string
	LLM   Inference

	Temperature *float64
	MaxTokens   *int64
}

// JudgmentRequest encapsulates a request for the judge agent to evaluate the conversation.
// When present on AgentInput, signals the judge to produce a verdict.
type JudgmentRequest struct {
	// Criteria to evaluate, overriding the judge agent's configured criteria.
	Criteria []string
	// ForceDecision forces the judge to use finish_test (no continue_test option).
	ForceDecision bool
}

// JudgeOption configures optional behavior for a Judge() script step.
type JudgeOption func(*JudgeOptions)

// JudgeOptions holds options for a Judge() script step call.
type JudgeOptions struct {
	Criteria []string
}

// WithJudgeCriteria sets inline criteria for a judge checkpoint.
func WithJudgeCriteria(criteria ...string) JudgeOption {
	return func(o *JudgeOptions) {
		o.Criteria = criteria
	}
}

type AgentInput struct {
	ThreadID        string
	Messages        []Message
	NewMessages     []Message
	RequestedRole   AgentRole
	JudgmentRequest *JudgmentRequest
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
	MessagesValue       []Message
	MessageValue        Message
}

func NewStringAgentReturn(s string) *AgentReturn {
	return &AgentReturn{Kind: AgentReturnString, StringValue: s}
}
func NewScenarioResultAgentReturn(r ScenarioResult) *AgentReturn {
	return &AgentReturn{Kind: AgentReturnScenarioResult, ScenarioResultValue: r}
}
func NewMessagesAgentReturn(msgs []Message) *AgentReturn {
	return &AgentReturn{Kind: AgentReturnMessages, MessagesValue: msgs}
}
func NewEmptyAgentReturn() *AgentReturn {
	return &AgentReturn{Kind: AgentReturnMessages, MessagesValue: []Message{}}
}
func NewMessageAgentReturn(msg Message) *AgentReturn {
	return &AgentReturn{Kind: AgentReturnMessage, MessageValue: msg}
}
