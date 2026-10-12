// Example: Gemini Live Interruption
//
// The user barges in on a long Gemini Live reply. Gemini has no
// client-side cancel: the new user audio (a fresh activityStart) arriving
// mid-reply makes the server cut its answer. The example checks the first
// reply was cut off (its segment is marked truncated) and that Gemini then
// answered the interrupting question.
//
// Two agent steps follow the barge-in: Gemini closes the cancelled turn a
// beat after the barge-in audio, so the first drains that stale boundary and
// the second captures the real recovery reply.
//
// Mirrors: javascript/examples/vitest/tests/voice/gemini-live-interruption.test.ts
package examples

import (
	"slices"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/geminilive"
)

func TestGeminiLiveInterruption(t *testing.T) {
	skipWithoutGemini(t)

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_gemini_live_interruption",
		Description: "User interrupts a Gemini Live agent mid-utterance via " +
			"voice.Interrupt. Gemini has no client-side cancel, so the " +
			"server's VAD must detect the overlap and cut the agent's reply.",
		Agents: []scenario.AgentAdapter{
			geminilive.New(geminilive.Options{
				Model:             geminilive.DefaultModel,
				Voice:             "Algieba",
				SystemInstruction: "You are a helpful assistant that gives long, detailed answers.",
			}),
			voiceUser("openai/nova", ""),
			judge(
				"The user simulator produced two distinct user turns, the second arriving while the agent was mid-reply (a mid-utterance interrupt, not a clean turn handoff)",
				"The user and agent exchanged native-audio turns over a real Gemini Live session",
				"The conversation is a coherent example of a mid-utterance interrupt landing on Gemini Live",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Tell me everything you can about your platform, in detail."),
			// Gemini's first audio can take well over 10 s on a cold socket;
			// the barge-in waits up to 25 s for it, so it lands in speech.
			voice.Interrupt(
				voice.WithContent("Sorry — what are your business hours?"),
				voice.WaitForSpeechTimeout(25*time.Second),
			),
			scenario.Agent(), // drains the cancelled turn's boundary
			scenario.Agent(), // captures the real recovery reply
			scenario.Judge(),
		},
		MaxTurns: 8,
	})

	vr := voiceResult(t, res)
	saveRecording(t, vr.Recording, "gemini_live_interruption")

	interrupts := interruptsOf(vr.Timeline)
	if len(interrupts) == 0 {
		t.Fatal("no user_interrupt event: the barge-in never fired")
	}
	if !slices.ContainsFunc(interrupts, func(e voice.VoiceEvent) bool { return e.Metadata["outcome"] == "fired_after_speech" }) {
		// Gemini's first audio exceeded even the 25 s budget: nothing was
		// speaking, so there is nothing to truncate. A timing artefact, not
		// a regression.
		t.Skip("the barge-in fired before Gemini spoke; re-run for a mid-utterance barge-in")
	}

	agents := segmentsOf(vr.Recording, voice.SpeakerAgent)
	if !slices.ContainsFunc(agents, func(s voice.AudioSegment) bool { return s.TranscriptTruncated }) {
		t.Fatal("the barge-in fired during speech but no agent segment is marked truncated")
	}
	last := 0.0
	for _, e := range interrupts {
		last = max(last, e.Time)
	}
	recovered := slices.ContainsFunc(agents, func(s voice.AudioSegment) bool {
		return s.StartTime > last && !s.TranscriptTruncated && len(s.Audio) > 0 && s.Transcript != ""
	})
	if !recovered {
		t.Fatal("no non-empty agent reply after the barge-in: Gemini's recovery was not captured")
	}
}
