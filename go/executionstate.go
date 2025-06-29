package scenario

import (
	"errors"
	"time"

	"github.com/langwatch/scenario/go/internal/libraries/ptr"
	"github.com/openai/openai-go"
)

// ScenarioExecutionState represents the immutable state of a scenario at a given turn.
// A new state should be created for each turn/iteration and passed down.
type ScenarioExecutionState struct {
	messages    []openai.ChatCompletionMessageParamUnion
	currentTurn int
	threadID    string
	description string
	config      ScenarioConfig
	startedAt   time.Time
}

// NewScenarioExecutionState creates a new initial state for a scenario.
func NewScenarioExecutionState(cfg ScenarioConfig) *ScenarioExecutionState {
	return &ScenarioExecutionState{
		messages:    []openai.ChatCompletionMessageParamUnion{},
		currentTurn: 0,
		threadID:    cfg.ThreadID,
		description: cfg.Description,
		config:      cfg,
		startedAt:   time.Now(),
	}
}

func (s *ScenarioExecutionState) AddMessage(msg openai.ChatCompletionMessageParamUnion) {
	s.messages = append(s.messages, msg)
}

func (s *ScenarioExecutionState) LastMessage() (*openai.ChatCompletionMessageParamUnion, error) {
	if len(s.messages) == 0 {
		return nil, errors.New("no messages in execution state history")
	}

	return &s.messages[len(s.messages)-1], nil
}

func (s *ScenarioExecutionState) LastUserMessage() (*openai.ChatCompletionUserMessageParam, error) {
	for i := len(s.messages) - 1; i >= 0; i-- {
		msg := s.messages[i]

		if ptr.ValueOrZero(msg.GetRole()) == "user" {
			return msg.OfUser, nil
		}
	}

	return nil, errors.New("no user messages in execution state history")
}

func (s *ScenarioExecutionState) LastToolCall(toolName string) (*openai.ChatCompletionToolMessageParam, *openai.ChatCompletionMessageToolCallParam, error) {
	toolCallIDToParam := make(map[string]*openai.ChatCompletionMessageToolCallParam)

	// collect tool call ids/params
	for i := len(s.messages) - 1; i >= 0; i-- {
		msg := s.messages[i]
		if ptr.ValueOrZero(msg.GetRole()) == "assistant" && msg.OfAssistant != nil {
			for _, tc := range msg.OfAssistant.ToolCalls {
				// Only store if matches toolName
				if tc.Function.Name == toolName {
					// Need pointer to tc for return
					tcCopy := tc
					toolCallIDToParam[tc.ID] = &tcCopy
				}
			}
		}
	}

	// find the last tool message with a matching tool name
	for i := len(s.messages) - 1; i >= 0; i-- {
		msg := s.messages[i]
		if ptr.ValueOrZero(msg.GetRole()) != "tool" || msg.OfTool == nil {
			continue
		}
		toolMsg := msg.OfTool
		toolCallID := toolMsg.ToolCallID
		if tc, ok := toolCallIDToParam[toolCallID]; ok {
			return toolMsg, tc, nil
		}
	}

	return nil, nil, errors.New("no tool call result for tool '" + toolName + "' in execution state history")
}

func (s *ScenarioExecutionState) HasToolCall(toolName string) bool {
	_, _, err := s.LastToolCall(toolName)
	if err != nil {
		return false
	}

	return true
}

// Messages returns a copy of the messages in the state.
func (s *ScenarioExecutionState) Messages() []openai.ChatCompletionMessageParamUnion {
	return append([]openai.ChatCompletionMessageParamUnion(nil), s.messages...)
}

// CurrentTurn returns the current turn number.
func (s *ScenarioExecutionState) CurrentTurn() int {
	return s.currentTurn
}

// ThreadID returns the thread ID for the scenario.
func (s *ScenarioExecutionState) ThreadID() string {
	return s.threadID
}

// Description returns the scenario description.
func (s *ScenarioExecutionState) Description() string {
	return s.description
}

// Config returns the scenario config.
func (s *ScenarioExecutionState) Config() ScenarioConfig {
	return s.config
}
