// Example: Interruption Recovery
//
// The flagship voice capability: the user cuts the agent off mid-reply
// twice and the agent must follow the pivot each time. It shows both forms
// of a barge-in:
//
//  1. Unrolled: voice.AgentNonBlocking() starts the agent's reply in the
//     background, and the next scenario.User line overlaps it. The run waits
//     for the agent to actually speak, sends the transport's interrupt and
//     the correction.
//  2. Sugar: voice.Interrupt(...), the same in one step.
//
// The bundled Pipecat bot greets on connect, so the script opens with an
// agent step: otherwise the first barge-in would cut off the greeting.
//
// Mirrors: javascript/examples/vitest/tests/voice/interruption-recovery.test.ts
package examples

import (
	"slices"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
)

func TestInterruptionRecovery(t *testing.T) {
	url := pipecatURL(t)

	bot, err := pipecat.New(pipecat.Options{URL: url, AudioFormat: "mulaw", SampleRate: 8000})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_interruption_recovery",
		Description: "The bot greets on connect; the user asks to set up two-factor " +
			"auth, then interrupts the bot's walk-through mid-reply to switch " +
			"to a password reset, then interrupts again to ask for a brief answer. " +
			"The bot must recover both times and follow the user's pivots rather " +
			"than answering a stale topic.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(bot),
			voiceUser("openai/nova", ""),
			judge(
				"The agent OPENED with a greeting on connect, THEN engaged the user's SPECIFIC requests as the conversation evolved — first the two-factor-authentication setup, then the mid-reply switch to a password reset, then keeping the answer brief",
				"The agent did NOT ignore the user or answer a DIFFERENT question than the one asked — it followed the user's pivot from 2FA to the password reset rather than continuing on the abandoned topic",
				"The agent recovered gracefully from BOTH interruptions — it kept responding rather than going silent after each barge-in",
				"The conversation is a coherent multi-turn example of the interruption-recovery flow",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the greeting
			scenario.User("I'm trying to turn on two-factor authentication but I'm stuck — can you walk me through it?"),
			voice.AgentNonBlocking(), // the bot starts a multi-step reply
			scenario.User("Actually — hold on, can you just reset my password instead?"), // barge-in #1
			scenario.Agent(), // recovery: the password reset
			scenario.User("Perfect. How long does the reset email take?"),
			voice.Interrupt( // barge-in #2
				voice.WithContent("Sorry — keep it short, I'm in a rush"),
				voice.WaitForSpeechTimeout(25*time.Second),
			),
			scenario.Agent(), // recovery: brief
			scenario.Judge(),
		},
		MaxTurns: 12,
	})

	vr := voiceResult(t, res)
	saveRecording(t, vr.Recording, "interruption_recovery")
	requireSuccess(t, res)

	interrupts := interruptsOf(vr.Timeline)
	if !slices.ContainsFunc(interrupts, func(e voice.VoiceEvent) bool { return e.Metadata["outcome"] == "fired_after_speech" }) {
		t.Fatalf("no barge-in landed while the agent spoke (%d interrupts): nothing was cut off", len(interrupts))
	}

	// The cut-off reply must be meaningfully shorter than a full one.
	agents := segmentsOf(vr.Recording, voice.SpeakerAgent)
	longest, shortestCut := 0.0, -1.0
	for _, s := range agents {
		d := s.EndTime - s.StartTime
		longest = max(longest, d)
		if s.TranscriptTruncated && (shortestCut < 0 || d < shortestCut) {
			shortestCut = d
		}
	}
	if shortestCut < 0 {
		t.Fatal("no agent segment is marked truncated: the interrupt did not cut off a reply")
	}
	if shortestCut/longest >= 0.8 {
		t.Errorf("the truncated reply (%.2fs) is not meaningfully shorter than a full one (%.2fs)", shortestCut, longest)
	}

	last := 0.0
	for _, e := range interrupts {
		last = max(last, e.Time)
	}
	if !slices.ContainsFunc(agents, func(s voice.AudioSegment) bool { return s.StartTime > last }) {
		t.Error("no agent audio after the last interrupt: the agent did not recover")
	}
	if lat := vr.Latency; lat != nil && lat.InterruptResponseTime != nil {
		t.Logf("interrupt response time: %.2fs", *lat.InterruptResponseTime)
	}
}
