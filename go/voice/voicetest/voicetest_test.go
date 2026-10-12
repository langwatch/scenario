package voicetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
)

func TestReceiveAudioHonoursTheTimeout(t *testing.T) {
	tr := &Transport{Turns: []Turn{{Delay: 150 * time.Millisecond, Chunks: []voice.AudioChunk{Tone(0.01, "late")}}}}
	ctx := context.Background()
	start := time.Now()
	if _, err := tr.ReceiveAudio(ctx, 30*time.Millisecond); !errors.Is(err, voice.ErrReceiveTimeout) {
		t.Fatalf("err = %v, want a receive timeout", err)
	}
	if d := time.Since(start); d > 120*time.Millisecond {
		t.Fatalf("timed-out receive took %v", d)
	}
	// The chunk is still due at its scheduled time, not delayed afresh.
	c, err := tr.ReceiveAudio(ctx, time.Second)
	if err != nil || c.Transcript != "late" {
		t.Fatalf("got %q, %v", c.Transcript, err)
	}
	if d := time.Since(start); d < 150*time.Millisecond || d > 400*time.Millisecond {
		t.Fatalf("chunk arrived after %v, want about 150ms", d)
	}
	if c, err := tr.ReceiveAudio(ctx, time.Second); err != nil || len(c.Data) != 0 {
		t.Fatalf("want the end-of-turn chunk, got %d bytes, %v", len(c.Data), err)
	}
}
