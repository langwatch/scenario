package scenario

import (
	"time"
)

// ScenarioEventType represents the type of event in scenario execution.
type ScenarioEventType string

const (
	EventRunStarted      ScenarioEventType = "SCENARIO_RUN_STARTED"
	EventMessageSnapshot ScenarioEventType = "SCENARIO_MESSAGE_SNAPSHOT"
	EventRunFinished     ScenarioEventType = "SCENARIO_RUN_FINISHED"
	EventError           ScenarioEventType = "SCENARIO_ERROR"
)

// ScenarioRunStatus represents the status of a scenario run.
type ScenarioRunStatus string

const (
	ScenarioRunStatusSuccess    ScenarioRunStatus = "SUCCESS"
	ScenarioRunStatusError      ScenarioRunStatus = "ERROR"
	ScenarioRunStatusCancelled  ScenarioRunStatus = "CANCELLED"
	ScenarioRunStatusInProgress ScenarioRunStatus = "IN_PROGRESS"
	ScenarioRunStatusPending    ScenarioRunStatus = "PENDING"
	ScenarioRunStatusFailed     ScenarioRunStatus = "FAILED"
)

// ScenarioEvent is the interface for all scenario events.
type ScenarioEvent interface {
	Type() ScenarioEventType
	Timestamp() time.Time
}

// RunStartedEvent is emitted when a scenario run starts.
type RunStartedEvent struct {
	timestamp      time.Time
	BatchRunID     string
	ScenarioRunID  string
	ScenarioSetID  string
	ScenarioID     string
	ScenarioName   string
	Description    string
	Metadata       map[string]any
}

func (e RunStartedEvent) Type() ScenarioEventType { return EventRunStarted }
func (e RunStartedEvent) Timestamp() time.Time    { return e.timestamp }

// MessageSnapshotEvent is emitted to snapshot the current messages.
type MessageSnapshotEvent struct {
	timestamp     time.Time
	BatchRunID    string
	ScenarioRunID string
	ScenarioSetID string
	ScenarioID    string
	Messages      []Message
}

func (e MessageSnapshotEvent) Type() ScenarioEventType { return EventMessageSnapshot }
func (e MessageSnapshotEvent) Timestamp() time.Time    { return e.timestamp }

// RunFinishedEvent is emitted when a scenario run finishes.
type RunFinishedEvent struct {
	timestamp     time.Time
	BatchRunID    string
	ScenarioRunID string
	ScenarioSetID string
	ScenarioID    string
	Result        *ScenarioResult
}

func (e RunFinishedEvent) Type() ScenarioEventType { return EventRunFinished }
func (e RunFinishedEvent) Timestamp() time.Time    { return e.timestamp }

// ErrorEvent is emitted when an error occurs during scenario execution.
type ErrorEvent struct {
	timestamp time.Time
	Error     error
	Fatal     bool
}

func (e ErrorEvent) Type() ScenarioEventType { return EventError }
func (e ErrorEvent) Timestamp() time.Time    { return e.timestamp }

// EventBus is the interface for publishing and subscribing to scenario events.
type EventBus interface {
	Publish(event ScenarioEvent)
	Subscribe() <-chan ScenarioEvent
	Unsubscribe(ch <-chan ScenarioEvent)
	Close()
	Drain()
}
