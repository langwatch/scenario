package scenario

import (
	"context"
	"errors"
	"fmt"
	"os"
)

var (
	ErrScenarioNameRequired         = errors.New("a scenario name is required")
	ErrScenarioDescriptionRequired  = errors.New("a scenario description is required")
	ErrMaxTurnsMustBePositive       = errors.New("the maximum number of turns must be positive")
	ErrNoAgentsSpecified            = errors.New("no agents specified")
	ErrNoAgentInAgentsWithAgentRole = errors.New("no agent was provided in the agents slice with the role agent")
	ErrAgentWithInvalidRole         = errors.New("agent with invalid role")
)

// RunOptions configures optional behavior for Run().
type RunOptions struct {
	// Endpoint is the LangWatch API endpoint for event reporting.
	Endpoint string
	// APIKey is the LangWatch API key for authentication.
	APIKey string
	// BatchRunID groups scenario runs. Falls back to SCENARIO_BATCH_RUN_ID env var.
	BatchRunID string
}

// RunOption configures a RunOptions.
type RunOption func(*RunOptions)

// WithEndpoint sets the LangWatch endpoint.
func WithEndpoint(endpoint string) RunOption {
	return func(o *RunOptions) { o.Endpoint = endpoint }
}

// WithAPIKey sets the LangWatch API key.
func WithAPIKey(apiKey string) RunOption {
	return func(o *RunOptions) { o.APIKey = apiKey }
}

// WithBatchRunID sets the batch run ID.
func WithBatchRunID(batchRunID string) RunOption {
	return func(o *RunOptions) { o.BatchRunID = batchRunID }
}

func Run(ctx context.Context, cfg ScenarioConfig, opts ...RunOption) (*ScenarioResult, error) {
	// Apply options
	options := &RunOptions{}
	for _, opt := range opts {
		opt(options)
	}

	// Validate
	if cfg.Name == "" {
		return nil, ErrScenarioNameRequired
	}
	if cfg.Description == "" {
		return nil, ErrScenarioDescriptionRequired
	}
	if cfg.MaxTurns < 0 {
		return nil, ErrMaxTurnsMustBePositive
	}
	if cfg.MaxTurns == 0 {
		cfg.MaxTurns = 10 // Default
	}
	if len(cfg.Agents) == 0 {
		return nil, ErrNoAgentsSpecified
	}
	if err := validateAgentsSlice(cfg.Agents); err != nil {
		return nil, err
	}

	// Apply defaults
	if cfg.ThreadID == "" {
		cfg.ThreadID = generateThreadID(ctx)
	}
	if cfg.ID == "" {
		cfg.ID = generateScenarioID(ctx)
	}

	script := cfg.Script
	if len(script) == 0 {
		script = []ScriptStep{
			Proceed(),
		}
	}

	// Determine batch run ID
	batchRunID := options.BatchRunID
	if batchRunID == "" {
		batchRunID = getBatchRunID(ctx)
	}

	// Create event bus
	eventBus := NewEventBus()

	// Apply default SetID
	if cfg.SetID == "" {
		cfg.SetID = "default"
	}

	// Optionally set up event reporter
	endpoint := options.Endpoint
	if endpoint == "" {
		endpoint = os.Getenv("LANGWATCH_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = "https://app.langwatch.ai"
	}
	apiKey := options.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("LANGWATCH_API_KEY")
	}

	// Show greeting banner
	showGreeting(apiKey)

	reporter := NewEventReporter(endpoint, apiKey)
	ch := eventBus.Subscribe()

	// Start reporter goroutine
	reporterDone := make(chan struct{})
	scenarioSetID := cfg.SetID
	go func() {
		defer close(reporterDone)
		reporter.ReportEvents(ch, func(setURL string) {
			showWatchMessage(setURL, scenarioSetID)
		})
	}()

	// Set up observability (OTel tracing) if API key is configured
	var obsHandle *ObservabilityHandle
	if apiKey != "" {
		var err error
		obsHandle, err = setupObservability(ctx, endpoint, apiKey)
		if err != nil {
			// Non-fatal: continue without observability
			obsHandle = nil
		}
	}

	// Wire span collector into judge agents
	if obsHandle != nil {
		for _, agent := range cfg.Agents {
			if ja, ok := agent.(*JudgeAgent); ok {
				ja.spanCollector = obsHandle.collector
			}
		}
	}

	// Create execution and run
	execution := NewScenarioExecution(cfg, script, eventBus, batchRunID)
	if obsHandle != nil {
		execution.tracer = obsHandle.tracer
		execution.spanCollector = obsHandle.collector
	}
	result := execution.Run(ctx)

	// Drain event bus and wait for reporter
	eventBus.Drain()
	<-reporterDone

	// Shutdown observability
	if obsHandle != nil {
		obsHandle.Shutdown(ctx)
	}

	return result, nil
}

func validateAgentsSlice(agents []AgentAdapter) error {
	foundAgent := false
	for _, a := range agents {
		if a.Role() == AgentRoleAgent {
			foundAgent = true
			break
		}
	}
	if !foundAgent {
		return ErrNoAgentInAgentsWithAgentRole
	}

	for i, a := range agents {
		role := a.Role()

		if role != AgentRoleAgent && role != AgentRoleJudge && role != AgentRoleUser {
			return fmt.Errorf("%v: index:%d given:%s", ErrAgentWithInvalidRole, i, role)
		}
	}

	return nil
}
