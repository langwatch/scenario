//go:build integration

package geminilive

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/tts"
)

// TestLiveGeminiAnswersASpokenQuestion runs against the real Gemini Live
// API; the question is synthesized with OpenAI TTS.
func TestLiveGeminiAnswersASpokenQuestion(t *testing.T) {
	if os.Getenv("GEMINI_API_KEY") == "" && os.Getenv("GOOGLE_API_KEY") == "" {
		t.Skip("GEMINI_API_KEY not set")
	}
	if os.Getenv("OPENAI_API_KEY") == "" {
		t.Skip("OPENAI_API_KEY not set (needed to synthesize the question)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	question, err := tts.Default().Synthesize(ctx, "Hi, what is the capital of France?", "openai/nova")
	if err != nil {
		t.Fatal(err)
	}
	rt := NewTransport(Options{SystemInstruction: "Answer in one short sentence."})
	if err := rt.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer rt.Disconnect(ctx)
	if err := rt.SendAudio(ctx, question); err != nil {
		t.Fatal(err)
	}
	c, err := rt.ReceiveAudio(ctx, 30*time.Second)
	if err != nil || len(c.Data) == 0 {
		t.Fatalf("reply: %d bytes, %v", len(c.Data), err)
	}
}
