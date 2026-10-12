// Example: Realtime User Drives a Hosted ElevenLabs Agent
//
// Realtime to realtime, no TTS on the user side: an OpenAI Realtime model
// in the user role speaks each scripted line itself, and the spoken audio
// (with the model's transcript) is delivered to a hosted ElevenLabs ConvAI
// agent, which answers in audio. The judge grades whether the two actually
// heard each other.
//
// Mirrors: javascript/examples/vitest/tests/voice/realtime-user-hosted-el.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/adapters/elevenlabs"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
)

// agentsHeardEachOther is the mutual-hearing criterion: segment counts
// prove audio moved, this proves the agents understood each other.
const agentsHeardEachOther = "Mutual hearing & coherence: every agent turn directly and specifically " +
	"addresses what the user actually said in the immediately preceding turn, " +
	"demonstrating the agent heard and understood the user's speech. The dialogue " +
	"must read as a real two-way conversation that makes sense end to end — NOT a " +
	"non-sequitur, NOT answering a different question, NOT a canned line that " +
	"ignores the user's words, NOT two scripts talking past each other. An agent " +
	"that declines or deflects a request still satisfies this ONLY IF the decline " +
	"is a direct, on-topic response to what the user actually asked."

func TestRealtimeUserDrivesHostedElevenLabs(t *testing.T) {
	skipWithoutOpenAI(t)
	agentID := skipWithoutElevenLabsAgent(t)

	agent, err := elevenlabs.NewAgent(elevenlabs.Options{AgentID: agentID})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "realtime_user_drives_hosted_el",
		Description: "A realtime user (OpenAI Realtime, role=USER) speaks to a hosted " +
			"ElevenLabs ConvAI agent across multiple scripted turns. Real audio " +
			"flows both ways; the conversation is coherent.",
		Agents: []scenario.AgentAdapter{
			agent,
			openairealtime.New(openairealtime.Options{
				Model: openairealtime.DefaultModel,
				Voice: "marin",
				Instructions: "You are a customer contacting support about your account. " +
					"Keep each turn to one short sentence.",
				Role: scenario.AgentRoleUser,
			}),
			judge(agentsHeardEachOther),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the ElevenLabs greeting
			scenario.User("Hi, I have a question about my account."),
			scenario.Agent(),
			scenario.User("Thanks — can you tell me your support hours?"),
			scenario.Agent(),
			scenario.User("Got it. One more — how do I reset my password?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 12,
	})

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "realtime_user_hosted_el")
	requireTurns(t, rec, 3, 3)
	requireSuccess(t, res)
}
