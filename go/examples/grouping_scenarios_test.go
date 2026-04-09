// Example: Grouping Scenarios
//
// Demonstrates using SetID to group related scenarios and using
// simple echo agents with hardcoded messages and succeed().
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

type echoAgent struct{}

func (a *echoAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *echoAgent) Call(_ context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
	lastMsg := input.Messages[len(input.Messages)-1]
	return scenario.NewStringAgentReturn("You said: " + lastMsg.Content), nil
}

type dummyUserAgent struct{}

func (a *dummyUserAgent) Role() scenario.AgentRole { return scenario.AgentRoleUser }

func (a *dummyUserAgent) Call(_ context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
	return scenario.NewStringAgentReturn(""), nil
}

func TestGroupingScenarios_EchoFirst(t *testing.T) {
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Echo Test 1",
		Description: "The agent should echo back the user's first message.",
		SetID:       "echo-agent-suite",
		Agents:      []scenario.AgentAdapter{&echoAgent{}, &dummyUserAgent{}},
		Script: []scenario.ScriptStep{
			scenario.User("Hello world!"),
			scenario.Agent(),
			func(_ context.Context, _ scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				msg, err := state.LastAgentMessage()
				if err != nil {
					t.Fatal(err)
				}
				if msg.Content != "You said: Hello world!" {
					t.Fatalf("expected echo, got: %s", msg.Content)
				}
				return nil, nil
			},
			scenario.Succeed("Agent correctly echoed the message."),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}

func TestGroupingScenarios_EchoSecond(t *testing.T) {
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Echo Test 2",
		Description: "The agent should echo back the user's second message.",
		SetID:       "echo-agent-suite",
		Agents:      []scenario.AgentAdapter{&echoAgent{}, &dummyUserAgent{}},
		Script: []scenario.ScriptStep{
			scenario.User("This is another test."),
			scenario.Agent(),
			func(_ context.Context, _ scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				msg, err := state.LastAgentMessage()
				if err != nil {
					t.Fatal(err)
				}
				if msg.Content != "You said: This is another test." {
					t.Fatalf("expected echo, got: %s", msg.Content)
				}
				return nil, nil
			},
			scenario.Succeed("Agent correctly echoed the message."),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
