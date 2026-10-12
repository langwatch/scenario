//go:build integration

package voice_test

import (
	"context"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/livetest"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
)

// utterance is the known line the audio round trips must preserve.
const utterance = "The quick brown fox jumps over the lazy dog."

// audioRoundTrip is the port of ts-e2e-roundtrip, the audio fidelity
// gate: a known line is synthesized by the user simulator's TTS, carried
// as the canonical audio message, and transcribed back by the judge's STT
// pre-pass. A format mismatch anywhere on that path shows as a garbled
// transcript, so the far side must hold at least 80% of the words.
func audioRoundTrip(t *testing.T, ctx context.Context, voiceName string, provider stt.Provider) {
	t.Helper()
	chunk, err := tts.Default().Synthesize(ctx, utterance, voiceName)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunk.Data) == 0 {
		t.Fatal("TTS returned no audio")
	}
	// Drop the TTS transcript so the STT, not the synthesizer, answers.
	chunk.Transcript = ""
	msg := voice.AudioMessage(chunk, scenario.RoleUser)
	out := voice.TranscribeAudioMessages(ctx, []scenario.Message{msg}, provider, voice.TranscribeMessagesOptions{
		Warn: func(s string) { t.Errorf("transcription warning: %s", s) },
	})
	if len(out) != 1 {
		t.Fatalf("%d messages, want 1", len(out))
	}
	if voice.MessageHasAudio(out[0]) {
		t.Error("audio kept although IncludeAudio is off")
	}
	heard := out[0].Text()
	if got := livetest.WordOverlap(utterance, heard); got < 0.8 {
		t.Fatalf("round trip heard %q for %q (overlap %.2f)", heard, utterance, got)
	}
	t.Logf("%s: %q", voiceName, heard)
}

// TestLiveAudioRoundTripOpenAI runs the round trip on OpenAI TTS and STT,
// the STT resolved from a "provider/model" spec. Needs OPENAI_API_KEY.
func TestLiveAudioRoundTripOpenAI(t *testing.T) {
	livetest.Require(t, "OPENAI_API_KEY")
	ctx := livetest.Context(t, 2*time.Minute)
	provider, err := stt.Resolve("openai/gpt-4o-mini-transcribe")
	if err != nil {
		t.Fatal(err)
	}
	audioRoundTrip(t, ctx, "openai/alloy", provider)
}

// TestLiveAudioRoundTripElevenLabs runs the round trip on ElevenLabs TTS
// and Scribe STT. Needs ELEVENLABS_API_KEY.
func TestLiveAudioRoundTripElevenLabs(t *testing.T) {
	livetest.Require(t, "ELEVENLABS_API_KEY")
	ctx := livetest.Context(t, 2*time.Minute)
	audioRoundTrip(t, ctx, "elevenlabs/"+tts.ElevenLabsDefaultVoiceID, stt.NewElevenLabs(stt.ElevenLabsOptions{}))
}

// TestLiveAudioRoundTripAcrossProviders speaks with OpenAI and transcribes
// with ElevenLabs, so neither vendor reads its own audio. Needs
// OPENAI_API_KEY and ELEVENLABS_API_KEY.
func TestLiveAudioRoundTripAcrossProviders(t *testing.T) {
	livetest.Require(t, "OPENAI_API_KEY", "ELEVENLABS_API_KEY")
	ctx := livetest.Context(t, 2*time.Minute)
	audioRoundTrip(t, ctx, "openai/nova", stt.NewElevenLabs(stt.ElevenLabsOptions{}))
}
