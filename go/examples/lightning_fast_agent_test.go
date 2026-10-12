// Example: Lightning Fast Agent
//
// Ten runs of an agent that answers in a millisecond, to show the overhead
// of the framework itself. The script supplies every user message, so the
// user simulator never calls its model and no API key is needed.
//
// Mirrors: javascript/examples/vitest/tests/lightining-fast-agent.test.ts
package examples

import (
	"context"
	"fmt"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

func TestLightningFastAgent(t *testing.T) {
	agent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		time.Sleep(time.Millisecond) // a lightning fast response time
		return scenario.TextReturn("response to " + lastText(input.Messages)), nil
	})
	user := scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
		ModelConfig: scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"},
	})

	for i := 1; i <= 10; i++ {
		name := fmt.Sprintf("fast agent test #%d", i)
		t.Run(name, func(t *testing.T) {
			result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
				Name:        name,
				Description: "This test checks the performance of a lightning fast agent.",
				Agents:      []scenario.AgentAdapter{agent, user},
				Script: []scenario.ScriptStep{
					scenario.User("foo"),
					scenario.Agent(),
					scenario.User("bar"),
					scenario.Agent(),
					scenario.Succeed(),
				},
				SetID: "go-examples",
			})
			if err != nil {
				t.Fatal(err)
			}
			if !result.Success {
				t.Fatalf("scenario failed: %v", result.Reasoning)
			}
		})
	}
}
