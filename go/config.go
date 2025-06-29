package scenario

import (
	"context"
)

type AgentRole string

const (
	AgentRoleAgent AgentRole = "agent"
	AgentRoleUser  AgentRole = "user"
	AgentRoleJudge AgentRole = "judge"
)

type PlaceholderMessageType any

type AgentInput struct{}

type AgentAdapter interface {
	Role() AgentRole
	Call(ctx context.Context, input AgentInput) (any, error)
}

type State interface {
	Config() ScenarioConfig
	Description() string
	Messages() []PlaceholderMessageType
	ThreadID() string
	CurrentTurn() int

	AddMessage(message PlaceholderMessageType)

	LastMessage() PlaceholderMessageType
	LastUserMessage() PlaceholderMessageType

	LastToolCall(toolName string) PlaceholderMessageType
	HasToolCall(toolName string) bool
}

type Execution interface {
	Messages() []PlaceholderMessageType
	ThreadID() string

	Message(message PlaceholderMessageType) error

	UserString(content string) error
	UserMessage(message PlaceholderMessageType) error

	AgentString(content string) error
	AgentMessage(message PlaceholderMessageType) error

	JudgeString(content string) (*ScenarioResult, error)
	JudgeMessage(message PlaceholderMessageType) (*ScenarioResult, error)

	Proceed(turns *int, onTurn any, onStep any) (*ScenarioResult, error)

	Succeed(reasoning string) (*ScenarioResult, error)
	Fail(reasoning string) (*ScenarioResult, error)
}

type ScenarioResult struct{}

type ScriptStep func(state State, execution Execution) (*ScenarioResult, error)

type ScenarioConfig struct {
	ID          string
	Name        string
	Description string
	Agents      []AgentAdapter
	Script      []ScriptStep

	MaxTurns   *int
	ThreadID   string
	SetID      string
	BatchRunID string
}
