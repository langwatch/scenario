package scenario

import (
	"context"
	"time"

	"github.com/openai/openai-go"
)

type ScriptStep func(
	ctx context.Context,
	execution Execution,
	state ExecutionState,
) (*ScenarioResult, error)

type ExecutionState interface {
	Config() ScenarioConfig
	Description() string
	Messages() []openai.ChatCompletionMessageParamUnion
	ThreadID() string
	CurrentTurn() int

	AddMessage(message openai.ChatCompletionMessageParamUnion)

	LastMessage() (*openai.ChatCompletionMessageParamUnion, error)
	LastUserMessage() (*openai.ChatCompletionUserMessageParam, error)

	LastToolCall(toolName string) (*openai.ChatCompletionToolMessageParam, *openai.ChatCompletionMessageToolCallParam, error)
	HasToolCall(toolName string) bool
}

type Execution interface {
	Messages() []openai.ChatCompletionMessageParamUnion
	ThreadID() string

	Run(ctx context.Context) *ScenarioResult

	Message(ctx context.Context, message openai.ChatCompletionMessageParamUnion) error

	UserString(ctx context.Context, content string) error
	UserMessage(ctx context.Context, message openai.ChatCompletionUserMessageParam) error

	AgentString(ctx context.Context, content string) error
	AgentMessage(ctx context.Context, message openai.ChatCompletionAssistantMessageParam) error

	JudgeString(ctx context.Context, content string) (*ScenarioResult, error)
	JudgeMessage(ctx context.Context, message openai.ChatCompletionMessageParamUnion) (*ScenarioResult, error)

	Proceed(ctx context.Context, turns *int, onTurn any, onStep any) (*ScenarioResult, error)

	Succeed(ctx context.Context, reasoning string) (*ScenarioResult, error)
	Fail(ctx context.Context, reasoning string) (*ScenarioResult, error)
}

type ScenarioResult struct {
	Success       bool
	Messages      []openai.ChatCompletionMessageParamUnion
	Reasoning     *string
	MetCriteria   []string
	UnmetCriteria []string
	TotalTime     *time.Duration
	AgentTime     *time.Duration
	Error         *string
}
