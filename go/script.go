package scenario

func Message(message PlaceholderMessageType) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return nil, execution.Message(message)
	}
}

func UserString(content string) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return nil, execution.UserString(content)
	}
}

func UserMessage(message PlaceholderMessageType) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return nil, execution.UserMessage(message)
	}
}

func AgentString(content string) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return nil, execution.AgentString(content)
	}
}

func AgentMessage(message PlaceholderMessageType) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return nil, execution.AgentMessage(message)
	}
}

func JudgeString(content string) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return execution.JudgeString(content)
	}
}

func JudgeMessage(message PlaceholderMessageType) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return execution.JudgeMessage(message)
	}
}

// TODO(afr): Move this to an options pattern. `Proceed(WithProceedTurns(n)`, `Proceed(WithProceedOnTurn(func))`, `Proceed(WithProceedOnStep(func))`)
func Proceed(turns *int, onTurn any, onStep any) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return execution.Proceed(turns, onTurn, onStep)
	}
}

func Succeed(reasoning string) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return execution.Succeed(reasoning)
	}
}

func Fail(reasoning string) ScriptStep {
	return func(state State, execution Execution) (*ScenarioResult, error) {
		return execution.Fail(reasoning)
	}
}
