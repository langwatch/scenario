//go:build integration

package pipecat

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/voicetest"
)

// TestLiveBot talks to a running Pipecat bot (python bot.py -t twilio):
// set PIPECAT_URL (or PIPECAT_BOT_URL), such as ws://localhost:8765/ws.
func TestLiveBot(t *testing.T) {
	url := os.Getenv("PIPECAT_URL")
	if url == "" {
		url = os.Getenv("PIPECAT_BOT_URL")
	}
	if url == "" {
		t.Skip("missing env: one of PIPECAT_URL, PIPECAT_BOT_URL (a running Pipecat bot)")
	}
	a, err := New(Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := a.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(ctx)
	if err := a.SendAudio(ctx, voicetest.Tone(1, "")); err != nil {
		t.Fatal(err)
	}
	c, err := a.ReceiveAudio(ctx, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Data) == 0 {
		t.Fatal("the bot sent no audio")
	}
}
