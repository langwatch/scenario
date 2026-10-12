// Example: OpenAI Realtime as the User Simulator
//
// With the user role, the Realtime model is the voice of the user: a
// scripted line goes into the session as text and the model speaks it with
// natural prosody, no TTS involved. This adapter-level demo speaks two
// lines with a confused-elderly-customer persona and saves the spoken audio
// as a recording. For a realtime user driving an agent through
// scenario.Run, see realtime_user_hosted_elevenlabs_test.go.
//
// Mirrors: javascript/examples/vitest/tests/voice/openai-realtime-user.test.ts
package examples

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
	"github.com/langwatch/scenario/go/voice/audio"
)

func TestOpenAIRealtimeUser(t *testing.T) {
	skipWithoutOpenAI(t)

	user := openairealtime.New(openairealtime.Options{
		Model: openairealtime.DefaultModel,
		// GA Realtime voices: alloy, ash, ballad, coral, echo, sage, shimmer,
		// verse, marin, cedar.
		Voice: "marin",
		Instructions: "You are a confused elderly customer trying to reset your password. " +
			"Speak slowly with hesitation.",
		Role: scenario.AgentRoleUser,
	})
	if user.Role() != scenario.AgentRoleUser {
		t.Fatalf("role %q", user.Role())
	}

	rt := user.Realtime()
	if err := rt.Connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rt.Disconnect(t.Context()) }()

	// Segments are laid end to end on a byte-accurate cursor, so the
	// manifest's duration equals full.wav's.
	rec := &voice.VoiceRecording{}
	cursor := 0.0
	for _, line := range []string{
		"I forgot my password and need help.",
		"Oh — and I also can't remember my username.",
	} {
		spoken, err := rt.SpeakUserTurn(t.Context(), line)
		if err != nil {
			t.Fatalf("speak %q: %v", line, err)
		}
		if len(spoken.Data) == 0 {
			continue
		}
		seconds := audio.Seconds(spoken.Data)
		rec.Segments = append(rec.Segments, voice.AudioSegment{
			Speaker:    voice.SpeakerUser,
			StartTime:  cursor,
			EndTime:    cursor + seconds,
			Audio:      spoken.Data,
			Transcript: spoken.Transcript,
		})
		cursor += seconds
	}

	if len(rec.Segments) < 2 {
		t.Fatalf("expected two spoken user turns, got %d", len(rec.Segments))
	}
	saveRecording(t, rec, "openai_realtime_user")
}
