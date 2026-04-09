package scenario

type ScenarioConfig struct {
	ID          string
	Name        string
	Description string
	Agents      []AgentAdapter
	Script      []ScriptStep

	MaxTurns   int
	Verbose    bool
	ThreadID   string
	SetID      string
	BatchRunID string
	Metadata   map[string]any
}
