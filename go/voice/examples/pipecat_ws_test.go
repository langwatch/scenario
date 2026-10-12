// Example: Pipecat over WebSocket
//
// A user-run Pipecat bot is the agent under test. The pipecat adapter
// connects to the bot's socket as Twilio Media Streams would (µ-law 8 kHz),
// and a voice user simulator holds a three-exchange conversation with it.
//
// Start the bot first (python/examples/voice/_bot, `make voice-pipecat-up`)
// and set SCENARIO_PIPECAT_BOT_UP=1; PIPECAT_BOT_URL overrides
// ws://localhost:8765/stream.
//
// Mirrors: javascript/examples/vitest/tests/voice/pipecat-ws.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
)

func TestPipecatWebSocket(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "pipecat_twilio_smoke",
		Description: "A caller rings the phone bot. The bot greets them and answers a " +
			"brief question. The scenario records the conversation and judges " +
			"whether the bot was friendly and informative.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			voiceUser("openai/nova", ""),
			judge(
				"The agent and user exchanged multiple audio turns over the live Pipecat WebSocket",
				"The bot stayed engaged across the conversation and responded each time the user spoke",
				"The conversation is a coherent multi-turn example of a Pipecat-driven voice scenario",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hi! I'd love some help today."),
			scenario.Agent(),
			scenario.User("Great — can you tell me a little about what you can do?"),
			scenario.Agent(),
			scenario.User("Nice — and what else can you help me with?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})
	requireSuccess(t, res)

	rec := voiceResult(t, res).Recording
	requireTurns(t, rec, 3, 3)
	saveRecording(t, rec, "pipecat_ws")
	requireSpokenUserTurns(t, rec)
}
