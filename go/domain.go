package scenario

import (
	"context"
	"time"
)

type ScriptStep func(
	ctx context.Context,
	execution Execution,
	state ExecutionState,
) (*ScenarioResult, error)

type ProceedCallback func(state ExecutionState) error

type ExecutionState interface {
	Config() ScenarioConfig
	Description() string
	Messages() []Message
	ThreadID() string
	CurrentTurn() int

	AddMessage(message Message)
	IncrementTurn()

	LastMessage() (*Message, error)
	LastUserMessage() (*Message, error)
	LastAgentMessage() (*Message, error)

	LastToolCall(toolName string) (*Message, *ToolCall, error)
	HasToolCall(toolName string) bool
}

type Execution interface {
	Messages() []Message
	ThreadID() string

	Run(ctx context.Context) *ScenarioResult

	Message(ctx context.Context, message Message) error

	UserString(ctx context.Context, content string) error
	UserMessage(ctx context.Context, message Message) error

	AgentString(ctx context.Context, content string) error
	AgentMessage(ctx context.Context, message Message) error

	JudgeString(ctx context.Context, content string) (*ScenarioResult, error)
	JudgeMessage(ctx context.Context, message Message) (*ScenarioResult, error)

	User(ctx context.Context) error
	Agent(ctx context.Context) error
	Judge(ctx context.Context, opts ...JudgeOption) (*ScenarioResult, error)

	Proceed(ctx context.Context, opts ...ProceedOption) (*ScenarioResult, error)

	Succeed(ctx context.Context, reasoning string) (*ScenarioResult, error)
	Fail(ctx context.Context, reasoning string) (*ScenarioResult, error)
}

type ProceedOptions struct {
	Turns  int
	OnTurn ProceedCallback
	OnStep ProceedCallback
}

type ProceedOption func(*ProceedOptions)

func WithProceedTurns(turns int) ProceedOption {
	return func(opts *ProceedOptions) { opts.Turns = turns }
}
func WithProceedOnTurn(onTurn ProceedCallback) ProceedOption {
	return func(opts *ProceedOptions) { opts.OnTurn = onTurn }
}
func WithProceedOnStep(onStep ProceedCallback) ProceedOption {
	return func(opts *ProceedOptions) { opts.OnStep = onStep }
}

type ScenarioResult struct {
	RunID         string
	Success       bool
	Messages      []Message
	Reasoning     *string
	MetCriteria   []string
	UnmetCriteria []string
	TotalTime     *time.Duration
	AgentTime     *time.Duration
	Error         *string
}
