// Example: Custom Judge LLM
//
// Demonstrates building a fully custom judge agent that calls an LLM
// directly with structured output, giving full control over prompt,
// model, and response parsing.
//
// Mirrors: javascript/examples/vitest/tests/custom-judge-llm.test.ts
package examples

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// customLLMJudge is a judge that calls the LLM directly with structured output.
type customLLMJudge struct {
	criteria []string
	llm      scenario.Inference
}

func (j *customLLMJudge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }

func (j *customLLMJudge) Call(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
	if input.JudgmentRequest == nil {
		// Not asked to judge yet — continue
		return nil, nil
	}

	criteria := j.criteria
	if input.JudgmentRequest != nil && len(input.JudgmentRequest.Criteria) > 0 {
		criteria = input.JudgmentRequest.Criteria
	}

	// Build transcript
	transcript := ""
	for _, m := range input.Messages {
		transcript += fmt.Sprintf("%s: %s\n", m.Role, m.Content)
	}

	// Build criteria list
	criteriaList := ""
	for i, c := range criteria {
		criteriaList += fmt.Sprintf("%d. %s\n", i+1, c)
	}

	prompt := fmt.Sprintf(`Evaluate this conversation against the criteria.

Criteria:
%s
Conversation:
%s
Return a JSON object with fields: pass (bool), reasoning (string), results (array of {criterion: string, met: bool}).
Return ONLY valid JSON, no markdown.`, criteriaList, transcript)

	result, err := j.llm.Inference(ctx, scenario.InferenceParams{
		Model: "gpt-4.1-mini",
		Messages: []scenario.Message{
			scenario.UserMsg(prompt),
		},
	})
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Pass      bool   `json:"pass"`
		Reasoning string `json:"reasoning"`
		Results   []struct {
			Criterion string `json:"criterion"`
			Met       bool   `json:"met"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(result.Message.Content), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse judge response: %w\nraw: %s", err, result.Message.Content)
	}

	var met, unmet []string
	for _, r := range parsed.Results {
		if r.Met {
			met = append(met, r.Criterion)
		} else {
			unmet = append(unmet, r.Criterion)
		}
	}

	return scenario.NewScenarioResultAgentReturn(scenario.ScenarioResult{
		Success:       parsed.Pass,
		Reasoning:     &parsed.Reasoning,
		MetCriteria:   met,
		UnmetCriteria: unmet,
	}), nil
}

func TestCustomJudgeLLM(t *testing.T) {
	llm := newLLM()

	// A polite agent that always greets
	politeAgent := &staticAgent{
		response: "Hello! I'd be happy to help you with that. How can I assist you today?",
	}

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "custom LLM judge",
		Description: "User greets the agent",
		Agents: []scenario.AgentAdapter{
			politeAgent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{Model: "gpt-4.1-mini", LLM: llm},
			}),
			&customLLMJudge{
				criteria: []string{
					"Agent responds with a greeting",
					"Agent offers to help",
				},
				llm: llm,
			},
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hi there!"),
			scenario.Agent(),
			scenario.Judge(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
	if len(result.MetCriteria) != 2 {
		t.Fatalf("expected 2 met criteria, got %d", len(result.MetCriteria))
	}
}

// staticAgent always returns the same response.
type staticAgent struct {
	response string
}

func (a *staticAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *staticAgent) Call(_ context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.NewStringAgentReturn(a.response), nil
}
