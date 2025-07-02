package scenario

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrScenarioNameRequired         = errors.New("a scenario name is required")
	ErrScenarioDescriptionRequired  = errors.New("a scenario description is required")
	ErrMaxTurnsMustBePositive       = errors.New("the maximum number of turns must be positive")
	ErrNoAgentsSpecified            = errors.New("no agents specified")
	ErrNoAgentInAgentsWithAgentRole = errors.New("no agent was provided in the agents slice with the role agent")
	ErrAgentWithInvalidRole         = errors.New("agent with invalid role")
)

func Run(ctx context.Context, cfg ScenarioConfig) (*ScenarioResult, error) {
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

	if cfg.ThreadID == "" {
		cfg.ThreadID = generateThreadID(ctx)
	}

	if len(cfg.Script) == 0 {
		cfg.Script = []ScriptStep{
			Proceed(),
		}
	}

	return nil, nil
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
