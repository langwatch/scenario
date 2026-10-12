//go:build integration

package elevenlabs

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/tts"
)

// TestLiveRealVoiceIn runs one real-audio turn against a hosted agent:
// the agent greets, hears a synthesized user line (its STT transcript comes
// back) and answers with audio. It needs ELEVENLABS_AGENT_ID and
// ELEVENLABS_API_KEY (or ELEVENLABS_CONVAI_API_KEY).
func TestLiveRealVoiceIn(t *testing.T) {
	agentID := os.Getenv("ELEVENLABS_AGENT_ID")
	if agentID == "" || (os.Getenv("ELEVENLABS_API_KEY") == "" && os.Getenv("ELEVENLABS_CONVAI_API_KEY") == "") {
		t.Skip("ELEVENLABS_AGENT_ID and an ElevenLabs key are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	tr, err := New(Options{AgentID: agentID, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer tr.Disconnect(ctx)

	drain := func() int {
		t.Helper()
		first, err := tr.ReceiveAudio(ctx, voice.DefaultResponseTimeout)
		if err != nil {
			t.Fatal(err)
		}
		total := len(first.Data)
		for {
			c, err := tr.ReceiveAudio(ctx, 2*time.Second)
			if err != nil || len(c.Data) == 0 {
				return total
			}
			total += len(c.Data)
		}
	}
	if n := drain(); n == 0 {
		t.Fatal("no greeting audio")
	}
	if tr.ConversationID() == "" {
		t.Fatal("no conversation id")
	}

	line, err := tts.NewElevenLabs(tts.ElevenLabsOptions{}).Synthesize(ctx, "Hi, what are your opening hours this week?", tts.ElevenLabsDefaultVoiceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.SendAudio(ctx, voice.AudioChunk{Data: line}); err != nil {
		t.Fatal(err)
	}
	if n := drain(); n == 0 {
		t.Fatal("no answer audio")
	}
	if tr.LastUserTranscript() == "" || tr.AudioCommitCount() != 1 {
		t.Fatalf("user transcript %q, commits %d", tr.LastUserTranscript(), tr.AudioCommitCount())
	}
	t.Logf("agent said %q", tr.LastAgentTranscript())
}
