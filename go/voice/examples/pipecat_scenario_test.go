// Example: Pipecat Transport Smoke
//
// The smallest end-to-end check of the Pipecat transport: connect, send
// audio, receive audio and record, over two exchanges. It makes no
// conversation-quality or interruption claim; those live in the other
// Pipecat examples.
//
// Mirrors: javascript/examples/vitest/tests/voice/pipecat-scenario.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
)

func TestPipecatScenarioSmoke(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "pipecat_twilio_smoke",
		Description: "A caller rings the phone bot. The bot greets them and answers a " +
			"couple of brief questions over multiple turns. Scenario records " +
			"the conversation and judges whether the bot stayed engaged.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			voiceUser("openai/nova", ""),
			judge(
				"The agent and user exchanged multiple audio turns over the live Pipecat WebSocket",
				"The bot stayed responsive (it produced a reply each time the user spoke, not silence)",
				"The conversation is a coherent multi-turn Pipecat transport smoke",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hi! Can you help me with a question?"),
			scenario.Agent(),
			scenario.User("Thanks — what else can you do?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 6,
	})

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "pipecat_scenario")
	requireTurns(t, rec, 1, 1)
	if len(rec.Segments) < 4 {
		t.Fatalf("expected a multi-turn recording, got %d segments", len(rec.Segments))
	}
}
