// Example: OpenAI Realtime as the Agent
//
// The Realtime model itself is the agent under test. A voice user
// simulator speaks three scripted lines (TTS to audio), the model answers
// each in audio over one live session, and the judge evaluates the
// exchange. The user turns are then re-transcribed from their audio to
// prove real speech went over the wire.
//
// Mirrors: javascript/examples/vitest/tests/voice/openai-realtime-agent.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
)

func TestOpenAIRealtimeAgent(t *testing.T) {
	skipWithoutOpenAI(t)

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_openai_realtime_agent",
		Description: "OpenAI Realtime model plays the agent role. The user greets it; " +
			"the model responds in audio; the judge evaluates the exchange.",
		Agents: []scenario.AgentAdapter{
			openairealtime.New(openairealtime.Options{
				Model:        openairealtime.DefaultModel,
				Voice:        "alloy",
				Instructions: "You are a helpful assistant. Keep responses brief — one short sentence.",
			}),
			voiceUser("openai/nova", ""),
			judge(
				"The agent responded naturally to the user's greeting",
				"The agent answered the follow-up question on topic",
				"The conversation is a coherent multi-turn voice exchange",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me plan a weekend trip?"),
			scenario.Agent(),
			scenario.User("Great — what should I pack for cold weather?"),
			scenario.Agent(),
			scenario.User("And what is one local dish I should try there?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})
	requireSuccess(t, res)

	rec := voiceResult(t, res).Recording
	requireTurns(t, rec, 3, 3)
	saveRecording(t, rec, "openai_realtime_agent")
	requireSpokenUserTurns(t, rec)
}
