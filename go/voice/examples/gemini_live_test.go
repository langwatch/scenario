// Example: Gemini Live
//
// A Gemini Live native-audio model is the agent under test: a voice user
// simulator speaks three scripted lines and Gemini answers in native audio
// over one live session.
//
// The native-audio server now and then drops an agent turn's audio, so the
// example asserts the multi-turn shape (three spoken user turns, at least
// one agent reply) rather than the judge's verdict, as the JavaScript demo
// does.
//
// Mirrors: javascript/examples/vitest/tests/voice/gemini-live.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/adapters/geminilive"
)

// skipWithoutGemini skips unless the Gemini key the adapter reads
// (GEMINI_API_KEY, then GOOGLE_API_KEY) and OPENAI_API_KEY (user TTS, STT,
// judge) are set.
func skipWithoutGemini(t *testing.T) {
	t.Helper()
	skipWithoutAny(t, "GEMINI_API_KEY", "GOOGLE_API_KEY")
	skipWithoutOpenAI(t)
}

func TestGeminiLive(t *testing.T) {
	skipWithoutGemini(t)

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_gemini_live",
		Description: "Happy path against the Gemini native-audio model. " +
			"The user greets, Gemini responds in native audio; judge evaluates naturalness.",
		Agents: []scenario.AgentAdapter{
			geminilive.New(geminilive.Options{
				Model:             geminilive.DefaultModel,
				SystemInstruction: "You are a helpful assistant. Keep responses brief — one short sentence.",
			}),
			voiceUser("openai/nova", ""),
			judge(
				"The agent responded naturally to the first message",
				"The agent and user exchanged native-audio turns over a real Gemini Live session",
				"The conversation is a coherent multi-turn example of the Gemini Live native-audio path",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, I'm planning a trip to Japan next month."),
			scenario.Agent(),
			scenario.User("What's one thing I shouldn't miss in Kyoto?"),
			scenario.Agent(),
			scenario.User("And what is a good month to see the cherry blossoms?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})

	var users, agents int
	for _, m := range res.Messages {
		switch m.Role {
		case scenario.RoleUser:
			users++
		case scenario.RoleAssistant:
			agents++
		}
	}
	if users < 3 || agents < 2 {
		t.Fatalf("got %d user and %d agent messages, want at least 3 and 2", users, agents)
	}

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "gemini_live")
	requireTurns(t, rec, 3, 1)
	requireSpokenUserTurns(t, rec)
	t.Logf("judge (informative): success=%v %s", res.Success, res.Reasoning)
}
