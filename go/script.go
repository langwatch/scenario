package scenario

import (
	"context"
)

func MessageStep(message Message) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.Message(ctx, message)
	}
}

func UserString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.UserString(ctx, content)
	}
}

func UserMessage(message Message) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.UserMessage(ctx, message)
	}
}

// User calls the user simulator agent to generate a message, or if content is provided, adds it directly.
func User(content ...string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		if len(content) > 0 && content[0] != "" {
			return nil, execution.UserString(ctx, content[0])
		}
		return nil, execution.User(ctx)
	}
}

func AgentString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.AgentString(ctx, content)
	}
}

func AgentMessage(message Message) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return nil, execution.AgentMessage(ctx, message)
	}
}

// Agent calls the agent under test to generate a message, or if content is provided, adds it directly.
func Agent(content ...string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		if len(content) > 0 && content[0] != "" {
			return nil, execution.AgentString(ctx, content[0])
		}
		return nil, execution.Agent(ctx)
	}
}

func JudgeString(content string) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.JudgeString(ctx, content)
	}
}

func JudgeMessage(message Message) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.JudgeMessage(ctx, message)
	}
}

// Judge calls the judge agent to evaluate the conversation.
// Options allow passing inline criteria for checkpoint evaluation.
func Judge(opts ...JudgeOption) ScriptStep {
	return func(ctx context.Context, execution Execution, state ExecutionState) (*ScenarioResult, error) {
		return execution.Judge(ctx, opts...)
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
