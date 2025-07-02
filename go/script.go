package scenario

import (
	"context"

	"github.com/openai/openai-go"
)

func Message(message openai.ChatCompletionMessageParamUnion) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.Message(ctx, message)
	}
}

func UserString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.UserString(ctx, content)
	}
}

func UserMessage(message openai.ChatCompletionUserMessageParam) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.UserMessage(ctx, message)
	}
}

func AgentString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.AgentString(ctx, content)
	}
}

func AgentMessage(message openai.ChatCompletionAssistantMessageParam) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.AgentMessage(ctx, message)
	}
}

func JudgeString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.JudgeString(ctx, content)
	}
}

func JudgeMessage(message openai.ChatCompletionMessageParamUnion) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.JudgeMessage(ctx, message)
	}
}

// Proceed now uses an options pattern: Proceed(WithProceedTurns(n)), etc.
func Proceed(opts ...ProceedOption) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.Proceed(ctx, opts...)
	}
}

func Succeed(reasoning string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.Succeed(ctx, reasoning)
	}
}

func Fail(reasoning string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.Fail(ctx, reasoning)
	}
}
