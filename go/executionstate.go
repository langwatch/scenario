package scenario

import (
	"errors"
	"time"
)

// ScenarioExecutionState represents the mutable state of a scenario execution.
type ScenarioExecutionState struct {
	messages    []Message
	currentTurn int
	threadID    string
	description string
	config      ScenarioConfig
	startedAt   time.Time
}

// NewScenarioExecutionState creates a new initial state for a scenario.
func NewScenarioExecutionState(cfg ScenarioConfig) *ScenarioExecutionState {
	return &ScenarioExecutionState{
		messages:    []Message{},
		currentTurn: 0,
		threadID:    cfg.ThreadID,
		description: cfg.Description,
		config:      cfg,
		startedAt:   time.Now(),
	}
}

func (s *ScenarioExecutionState) AddMessage(msg Message) {
	s.messages = append(s.messages, msg)
}

func (s *ScenarioExecutionState) IncrementTurn() {
	s.currentTurn++
}

func (s *ScenarioExecutionState) LastMessage() (*Message, error) {
	if len(s.messages) == 0 {
		return nil, errors.New("no messages in execution state history")
	}

	return &s.messages[len(s.messages)-1], nil
}

func (s *ScenarioExecutionState) LastUserMessage() (*Message, error) {
	for i := len(s.messages) - 1; i >= 0; i-- {
		if s.messages[i].Role == MessageRoleUser {
			return &s.messages[i], nil
		}
	}

	return nil, errors.New("no user messages in execution state history")
}

// LastAgentMessage returns the last assistant message in the state.
func (s *ScenarioExecutionState) LastAgentMessage() (*Message, error) {
	for i := len(s.messages) - 1; i >= 0; i-- {
		if s.messages[i].Role == MessageRoleAssistant {
			return &s.messages[i], nil
		}
	}

	return nil, errors.New("no assistant messages in execution state history")
}

func (s *ScenarioExecutionState) LastToolCall(toolName string) (*Message, *ToolCall, error) {
	toolCallIDToParam := make(map[string]*ToolCall)

	// collect tool call ids/params from assistant messages
	for i := len(s.messages) - 1; i >= 0; i-- {
		msg := s.messages[i]
		if msg.Role == MessageRoleAssistant {
			for j := range msg.ToolCalls {
				tc := &msg.ToolCalls[j]
				if tc.Name == toolName {
					toolCallIDToParam[tc.ID] = tc
				}
			}
		}
	}

	// find the last tool message with a matching tool call ID
	for i := len(s.messages) - 1; i >= 0; i-- {
		msg := s.messages[i]
		if msg.Role != MessageRoleTool {
			continue
		}
		if tc, ok := toolCallIDToParam[msg.ToolCallID]; ok {
			return &s.messages[i], tc, nil
		}
	}

	return nil, nil, errors.New("no tool call result for tool '" + toolName + "' in execution state history")
}

func (s *ScenarioExecutionState) HasToolCall(toolName string) bool {
	_, _, err := s.LastToolCall(toolName)
	return err == nil
}

// Messages returns a copy of the messages in the state.
func (s *ScenarioExecutionState) Messages() []Message {
	return append([]Message(nil), s.messages...)
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
