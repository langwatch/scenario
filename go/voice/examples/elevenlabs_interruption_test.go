// Example: ElevenLabs Interruption
//
// The user barges in on a hosted ElevenLabs agent mid-reply. ConvAI has no
// client-side cancel (the adapter does not advertise interruption), so the
// barge-in is plain audio sent while the agent speaks: the server's VAD
// detects the overlap and cuts the reply. A per-session system prompt
// override makes the agent verbose so there is speech to interrupt.
//
// Mirrors: javascript/examples/vitest/tests/voice/elevenlabs-interruption.test.ts
package examples

import (
	"slices"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/elevenlabs"
)

func TestElevenLabsInterruption(t *testing.T) {
	skipWithoutOpenAI(t)
	agentID := skipWithoutElevenLabsAgent(t)

	agent, err := elevenlabs.NewAgent(elevenlabs.Options{
		AgentID: agentID,
		SystemPromptOverride: "You are a chatty product specialist. When asked about " +
			"products or features, give a long, detailed answer with several sentences.",
	})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_elevenlabs_interruption",
		Description: "User interrupts a hosted ElevenLabs ConvAI agent mid-utterance " +
			"via voice.Interrupt. ElevenLabs has no client-side cancel, so the " +
			"server's VAD must detect the overlap and cut the agent's reply.",
		Agents: []scenario.AgentAdapter{
			agent,
			voiceUser("openai/nova", ""),
			judge(
				"The user and agent exchanged audio over the live ElevenLabs ConvAI socket",
				"After the user's interrupting turn (asking about business hours), the agent's reply PIVOTS to acknowledge the new topic — it does NOT just keep describing products/features as if uninterrupted",
				"The conversation is a coherent example of a mid-utterance interrupt landing on ElevenLabs ConvAI and the agent acknowledging the topic shift",
			),
		},
		// The first user line goes out while the greeting plays: that is what
		// engages ElevenLabs' turn-taking.
		Script: []scenario.ScriptStep{
			scenario.User("Hello, I'd like to know about your products."),
			scenario.Agent(),
			scenario.User("Tell me about every product feature you offer in detail."),
			voice.Interrupt(
				voice.WithContent("Sorry, one more thing — what are your business hours?"),
				voice.WaitForSpeechTimeout(15*time.Second),
			),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 12,
	})

	vr := voiceResult(t, res)
	saveRecording(t, vr.Recording, "elevenlabs_interruption")
	if len(interruptsOf(vr.Timeline)) == 0 {
		t.Fatal("no user_interrupt event: the barge-in never fired")
	}
	if !slices.ContainsFunc(segmentsOf(vr.Recording, voice.SpeakerAgent), func(s voice.AudioSegment) bool { return s.TranscriptTruncated }) {
		t.Fatal("no agent segment is marked truncated: the server did not cut the reply")
	}
	t.Logf("judge (informative): success=%v %s", res.Success, res.Reasoning)
}
