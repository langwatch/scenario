// Example: Random Interruptions
//
// A voice user simulator with InterruptProbability barges in on agent
// turns at random during Proceed: at 0.7 over five turns, a run without a
// single interruption is about a 0.2% event. The judge checks the bot kept
// context after each one.
//
// Mirrors: python/examples/voice/random_interruptions.py (the JavaScript
// demos reference it but ship no file of their own)
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
)

func TestRandomInterruptions(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	user := voiceUser("openai/nova",
		// The persona pins the role so later turns do not drift into
		// assistant-flavoured lines.
		"A customer calling for help with their account. Speak as a customer would — "+
			"describing problems, asking questions, never offering help yourself.",
		func(o *voice.UserSimulatorOptions) { o.InterruptProbability = 0.7 },
	)

	res := run(t, scenario.ScenarioConfig{
		Name: "example_random_interruptions",
		Description: "A user simulator with 70% interruption probability calls the bot " +
			"for help with their account. Over 5 turns, most agent responses " +
			"are cut short. Judge: bot recovered context after interruptions.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			user,
			judge(
				"The agent continued the conversation after interruptions rather than stopping",
				"The conversation involved multiple turns between user and agent",
				"At least one agent turn was interrupted by the user during the run",
				"The agent recovered context after each interruption",
				"The conversation is a coherent example of probabilistic random interruptions",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the greeting
			scenario.User("I need help with my account"),
			scenario.Proceed(scenario.Turns(5)), // each agent turn may be interrupted
			scenario.Judge(),
		},
		MaxTurns: 14,
	})

	vr := voiceResult(t, res)
	saveRecording(t, vr.Recording, "random_interruptions")
	t.Logf("interruptions: %d", len(interruptsOf(vr.Timeline)))
	requireSuccess(t, res)
}
