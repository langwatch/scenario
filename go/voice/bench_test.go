package voice_test

import (
	"context"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

func BenchmarkExtractAudio(b *testing.B) {
	m := voice.AudioMessage(voicetest.Tone(1, "transcript"), scenario.RoleAssistant)
	b.ReportAllocs()
	for b.Loop() {
		if _, ok := voice.ExtractAudio(m); !ok {
			b.Fatal("no audio")
		}
	}
}

// BenchmarkTurnDrain measures one agent turn draining 50 frames of 20 ms.
func BenchmarkTurnDrain(b *testing.B) {
	frame := voicetest.Tone(0.02, "")
	n := 0
	tr := &voicetest.Transport{Receive: func(context.Context, time.Duration) (voice.AudioChunk, error) {
		n++
		if n%51 == 0 {
			return voice.AudioChunk{}, nil
		}
		return frame, nil
	}}
	a := voice.NewAgent(tr)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := a.Turn(context.Background(), scenario.AgentInput{}); err != nil {
			b.Fatal(err)
		}
	}
}
