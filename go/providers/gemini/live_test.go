//go:build integration

package gemini_test

import (
	"context"
	"testing"

	"github.com/langwatch/scenario/go/internal/livetest"
	scenariogemini "github.com/langwatch/scenario/go/providers/gemini"
	"google.golang.org/genai"
)

// TestLiveGemini runs the shared provider suite against the real Gemini
// API. Needs GEMINI_API_KEY (or GOOGLE_API_KEY); SCENARIO_LIVE_GEMINI_MODEL
// overrides the model.
func TestLiveGemini(t *testing.T) {
	key := livetest.RequireAny(t, "GEMINI_API_KEY", "GOOGLE_API_KEY")
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{APIKey: key, Backend: genai.BackendGeminiAPI})
	if err != nil {
		t.Fatal(err)
	}
	livetest.RunProviderSuite(t, livetest.Provider{
		Name:  "gemini",
		LLM:   scenariogemini.NewProvider(client),
		Model: livetest.Env("SCENARIO_LIVE_GEMINI_MODEL", "gemini-2.5-flash"),
	})
}
