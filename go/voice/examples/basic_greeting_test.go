// Example: Basic Greeting
//
// The standard voice pipeline end to end over a live Pipecat bot: the bot
// greets on connect, a voice user simulator asks for something specific
// twice, and the judge checks the bot engaged with the requests rather than
// repeating a canned greeting.
//
// Mirrors: javascript/examples/vitest/tests/voice/basic-greeting.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
)

func TestBasicGreeting(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_basic_greeting",
		Description: "A caller rings the bot. The bot greets them; the caller asks for " +
			"help ordering pizza, the bot responds; the caller asks about " +
			"delivery time, the bot responds again.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			voiceUser("openai/nova", ""),
			judge(
				"The agent greeted the user naturally and in a friendly tone",
				"Over the conversation the agent ENGAGED with the caller's specific requests — the food order and/or the delivery question. It did NOT merely repeat a generic canned greeting that ignores everything the caller asked.",
				"The conversation is a coherent multi-turn greeting + help flow",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the bot greets on connect
			scenario.User("Hi, I'd like to order a large pepperoni pizza for delivery."),
			scenario.Agent(),
			scenario.User("Great — how long will delivery take?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "basic_greeting")
	// The greeting plus two exchanges.
	requireTurns(t, rec, 2, 2)
	if len(rec.Segments) < 4 {
		t.Errorf("expected a multi-turn recording, got %d segments", len(rec.Segments))
	}
	requireSuccess(t, res)
}
