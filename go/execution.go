package scenario

import (
	"context"
	"errors"
	"time"

	"github.com/langwatch/scenario/go/internal/libraries/ptr"
	"github.com/openai/openai-go"
)

type ScenarioExecution struct {
	cfg      ScenarioConfig
	state    *ScenarioExecutionState
	eventBus EventBus
	script   []ScriptStep
}

func NewScenarioExecution(cfg ScenarioConfig, script []ScriptStep, eventBus EventBus) *ScenarioExecution {
	return &ScenarioExecution{
		cfg:      cfg,
		state:    NewScenarioExecutionState(cfg),
		eventBus: eventBus,
		script:   script,
	}
}

// State returns the current state of the Scenario's execution.
func (e *ScenarioExecution) State() *ScenarioExecutionState {
	return e.state
}

// Execute runs the scenario from start to finish, emitting events as it goes.
func (e *ScenarioExecution) Run(ctx context.Context) *ScenarioResult {
	e.emitEvent(RunStartedEvent{
		timestamp:    time.Now(),
		ScenarioID:   e.cfg.ID,
		ScenarioName: e.cfg.Name,
		Description:  e.cfg.Description,
	})

	for _, step := range e.script {
		if ctx.Err() != nil {
			e.emitEvent(ErrorEvent{timestamp: time.Now(), Error: ctx.Err(), Fatal: true})
			break
		}

		result, err := step(ctx, e, e.state)
		if err != nil {
			e.emitEvent(ErrorEvent{timestamp: time.Now(), Error: err, Fatal: true})
			break
		}

		e.emitEvent(MessageSnapshotEvent{timestamp: time.Now(), Messages: e.state.Messages()})

		if result != nil {
			e.emitEvent(RunFinishedEvent{timestamp: time.Now(), Result: result})
			return result
		}
	}

	// If no result, treat as failure
	// TODO(afr): Proper error here
	failResult := &ScenarioResult{
		Success:       false,
		Messages:      e.state.messages,
		Reasoning:     nil,
		MetCriteria:   []string{},
		UnmetCriteria: []string{},
		TotalTime:     ptr.Ptr(time.Since(e.state.startedAt)),
		Error:         ptr.Ptr("no result was created"),
	}
	e.emitEvent(RunFinishedEvent{timestamp: time.Now(), Result: failResult})

	return failResult
}

func (e *ScenarioExecution) Messages() []openai.ChatCompletionMessageParamUnion {
	return e.state.Messages()
}

func (e *ScenarioExecution) ThreadID() string {
	return e.state.ThreadID()
}

func (e *ScenarioExecution) Message(ctx context.Context, message openai.ChatCompletionMessageParamUnion) error {
	return errors.New("execution Message not implemented")
}

func (e *ScenarioExecution) UserString(ctx context.Context, content string) error {
	return errors.New("execution UserString not implemented")
}
func (e *ScenarioExecution) UserMessage(ctx context.Context, message openai.ChatCompletionUserMessageParam) error {
	return errors.New("execution UserMessage not implemented")
}

func (e *ScenarioExecution) AgentString(ctx context.Context, content string) error {
	return errors.New("execution AgentString not implemented")
}
func (e *ScenarioExecution) AgentMessage(ctx context.Context, message openai.ChatCompletionAssistantMessageParam) error {
	return errors.New("execution AgentMessage not implemented")
}

func (e *ScenarioExecution) JudgeString(ctx context.Context, content string) (*ScenarioResult, error) {
	return nil, errors.New("execution JudgeString not implemented")
}
func (e *ScenarioExecution) JudgeMessage(ctx context.Context, message openai.ChatCompletionMessageParamUnion) (*ScenarioResult, error) {
	return nil, errors.New("execution JudgeMessage not implemented")
}

func (e *ScenarioExecution) Proceed(ctx context.Context, turns *int, onTurn any, onStep any) (*ScenarioResult, error) {
	return nil, errors.New("execution Proceed not implemented")
}

func (e *ScenarioExecution) Succeed(ctx context.Context, reasoning string) (*ScenarioResult, error) {
	return &ScenarioResult{}, nil
}
func (e *ScenarioExecution) Fail(ctx context.Context, reasoning string) (*ScenarioResult, error) {
	return nil, errors.New("execution Fail not implemented")
}

func (e *ScenarioExecution) emitEvent(event ScenarioEvent) {
	if e.eventBus != nil {
		e.eventBus.Publish(event)
	}
}
