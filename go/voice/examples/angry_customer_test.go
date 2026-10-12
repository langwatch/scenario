// Example: Angry Customer in a Noisy Cafe
//
// The user simulator is a furious caller whose synthesized voice is
// degraded after TTS: cafe ambience mixed in, then phone-line quality. The
// judge grades the agent's empathy and resolution; the code checks the
// half the judge cannot read from a transcript, that the ambience was
// actually mixed into the user's audio.
//
// With ELEVENLABS_API_KEY set, the user speaks with an ElevenLabs voice
// that honours inline tonal markers such as [shouting]; otherwise an OpenAI
// voice is used.
//
// Mirrors: javascript/examples/vitest/tests/voice/angry-customer.test.ts
package examples

import (
	"os"
	"slices"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/effects"
)

const angryPersona = "You are the FURIOUS CUSTOMER who was charged twice and is " +
	"calling from a noisy cafe. You are NOT the support agent. " +
	"NEVER apologize, NEVER say sorry, NEVER offer help, NEVER offer " +
	"empathy, NEVER explain a refund process, NEVER mirror or echo " +
	"the agent's lines — that is THEIR job, not yours. You only " +
	"complain, demand the charge be fixed, and stay impatient. Reply " +
	"with 1–2 SHORT, heated sentences MAXIMUM per turn — never a paragraph. " +
	"IMPORTANT: format every reply with ElevenLabs tonal markers " +
	"inline so the synthesised voice sounds audibly angry, not " +
	"just textually. Use markers like [shouting], [angry], [sigh], " +
	"[exhales sharply], [frustrated], and keep at least one in EVERY " +
	"turn. Example: '[shouting] You charged me the wrong amount! " +
	"[angry] Fix it NOW.' Do not strip the markers — the TTS reads " +
	"them as performance cues."

func TestAngryCustomer(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	voiceName := "openai/onyx"
	if os.Getenv("ELEVENLABS_API_KEY") != "" {
		voiceName = "elevenlabs/EXAVITQu4vr4xnSDxMaL"
	}
	user := voiceUser(voiceName, angryPersona, func(o *voice.UserSimulatorOptions) {
		o.AudioEffects = []effects.Effect{
			effects.Must(effects.BackgroundNoise(effects.Cafe, 0.4)),
			effects.PhoneQuality(),
		}
	})

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_angry_customer",
		Description: "An angry customer calls from a noisy cafe about a wrong charge. " +
			"The bot must handle the emotional tone and background noise, " +
			"demonstrate empathy, and work toward a resolution.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			user,
			judge(
				"The agent demonstrated empathy toward the angry customer and stayed calm despite the hostility",
				"The agent offered a concrete resolution or next step (a refund, a correction of the charge, escalation to a supervisor) rather than deflecting",
				"The user is an emotionally heightened, impatient caller — not a calm, neutral speaker",
				"The conversation is a coherent example of an angry-customer-in-a-noisy-cafe scenario",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the greeting
			scenario.User(),
			scenario.Agent(),
			scenario.User(),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "angry_customer")
	requireTurns(t, rec, 1, 1)
	if len(rec.Segments) < 4 {
		t.Fatalf("expected a multi-turn recording, got %d segments", len(rec.Segments))
	}

	users := segmentsOf(rec, voice.SpeakerUser)
	for _, s := range users {
		// A 1–2 sentence heated turn; a much longer one means the
		// simulator drifted into the agent's role.
		if d := audio.Seconds(s.Audio); d >= 12 {
			t.Errorf("a user turn ran %.1fs: too long for a short heated turn", d)
		}
	}
	// Measure the noise floor on the longest user turn.
	longest := slices.MaxFunc(users, func(a, b voice.AudioSegment) int { return len(a.Audio) - len(b.Audio) })
	if floor := noiseFloorRMS(longest.Audio); floor <= 60 {
		t.Errorf("user audio noise floor %.0f is too low: the cafe ambience was not mixed in", floor)
	}
	requireSuccess(t, res)
}
