package internal

import (
	"encoding/json"
	"fmt"
)

type JudgeAgentFinishTestToolArguments struct {
	Verdict   string
	Reasoning string
	Criteria  map[string]interface{}
}

func ParseJudgeAgentFinishTestToolArguments(arguments string) (*JudgeAgentFinishTestToolArguments, error) {
	var resp *JudgeAgentFinishTestToolArguments
	if err := json.Unmarshal([]byte(arguments), &resp); err != nil {
		return nil, fmt.Errorf("failed to parse judge agent finish tool arguments: %w", err)
	}

	if resp.Verdict == "" {
		resp.Verdict = "inconclusive"
	}
	if resp.Reasoning == "" {
		resp.Reasoning = "No reasoning provided"
	}
	if resp.Criteria == nil {
		resp.Criteria = map[string]interface{}{}
	}

	return resp, nil
}
