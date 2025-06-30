package scenario

type ScenarioConfig struct {
	ID          string
	Name        string
	Description string
	Agents      []AgentAdapter
	Script      []ScriptStep

	MaxTurns   int
	ThreadID   string
	SetID      string
	BatchRunID string
}
