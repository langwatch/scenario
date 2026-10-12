//go:build integration

package openairealtime

import (
	"context"
	"os"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// TestLiveRealtimeUserTalksToRealtimeAgent runs against the real OpenAI
// Realtime API: a realtime user speaks a line, a realtime agent answers it.
func TestLiveRealtimeUserTalksToRealtimeAgent(t *testing.T) {
	if os.Getenv("OPENAI_API_KEY") == "" && os.Getenv("OPENAI_REALTIME_API_KEY") == "" {
		t.Skip("OPENAI_API_KEY not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	user := New(Options{Role: scenario.AgentRoleUser, Instructions: "You are a customer asking about opening hours."})
	if err := user.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer user.Realtime().Disconnect(ctx)
	line, err := user.SpeakUserTurn(ctx, "Hi, what are your opening hours?")
	if err != nil || len(line.Data) == 0 {
		t.Fatalf("user line: %d bytes, %v", len(line.Data), err)
	}
	t.Logf("user said %q (%d bytes)", line.Transcript, len(line.Data))

	agent := New(Options{Instructions: "You are a shop assistant. We open 9 to 5. Answer briefly."})
	if err := agent.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer agent.Realtime().Disconnect(ctx)
	if err := agent.Realtime().SendAudio(ctx, line); err != nil {
		t.Fatal(err)
	}
	first, err := agent.Realtime().ReceiveAudio(ctx, 30*time.Second)
	if err != nil || len(first.Data) == 0 {
		t.Fatalf("agent reply: %d bytes, %v", len(first.Data), err)
	}
}
