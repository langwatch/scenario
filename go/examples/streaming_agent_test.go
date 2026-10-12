// Example: Streaming Agent with Granular Events
//
// With granular events on, an agent can show its message while it is being
// produced: AgentInput.Stream takes text deltas and tool call progress, and
// the run posts them to LangWatch as text message start/content/end events
// instead of one snapshot per message. The message the agent returns stays
// the source of truth. Stream is nil, and its methods do nothing, when
// granular events are off, so the same agent works either way.
//
// Turn granular events on per run with WithGranularEventsForRun(true), for
// the process with Configure(WithGranularEvents(true)), or with
// SCENARIO_SEND_GRANULAR_EVENTS=true.
//
// Mirrors: the granular message events of the JS SDK (AgentInput.stream)
package examples

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go/v3"
)

// streamingAgent streams an OpenAI chat completion into AgentInput.Stream.
type streamingAgent struct {
	client openai.Client
}

func (streamingAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a streamingAgent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	msgs := append([]scenario.Message{
		scenario.SystemMsg("You are a friendly travel agent. Keep answers under three sentences."),
	}, in.Messages...)

	stream := a.client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{
		Model:    "gpt-4.1-mini",
		Messages: scenarioopenai.ToOpenAIMessages(msgs),
	})
	defer stream.Close()

	var text strings.Builder
	for stream.Next() {
		for _, choice := range stream.Current().Choices {
			if d := choice.Delta.Content; d != "" {
				text.WriteString(d)
				in.Stream.TextDelta(d) // a no-op when granular events are off
			}
		}
	}
	if err := stream.Err(); err != nil {
		return nil, err
	}
	return scenario.TextReturn(text.String()), nil
}

func TestStreamingAgentGranularEvents(t *testing.T) {
	skipWithoutOpenAI(t)
	client := openai.NewClient()
	model := scenario.ModelConfig{LLM: scenarioopenai.NewProvider(&client), Model: "gpt-4.1-mini"}

	var deltas atomic.Int64
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "streaming travel agent",
		Description: "The user asks for a weekend trip idea in Europe.",
		Agents: []scenario.AgentAdapter{
			streamingAgent{client: client},
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria:    []string{"The agent suggests a destination in Europe"},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Any idea for a weekend trip in Europe?"),
			scenario.Agent(),
			scenario.Judge(),
		},
	},
		scenario.WithGranularEventsForRun(true),
		scenario.WithEventListener(func(e scenario.Event) {
			if e.Type == scenario.EventTextMessageContent {
				deltas.Add(1)
			}
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}
	if deltas.Load() == 0 {
		t.Error("expected text message content events")
	}
}
