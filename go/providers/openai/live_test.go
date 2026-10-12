//go:build integration

package openai_test

import (
	"testing"

	"github.com/langwatch/scenario/go/internal/livetest"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go/v3"
)

// TestLiveOpenAI runs the shared provider suite against the real Chat
// Completions API. Needs OPENAI_API_KEY; SCENARIO_LIVE_OPENAI_MODEL
// overrides the model.
func TestLiveOpenAI(t *testing.T) {
	livetest.Require(t, "OPENAI_API_KEY")
	client := openai.NewClient() // reads OPENAI_API_KEY and OPENAI_BASE_URL
	livetest.RunProviderSuite(t, livetest.Provider{
		Name:  "openai",
		LLM:   scenarioopenai.NewProvider(&client),
		Model: livetest.Env("SCENARIO_LIVE_OPENAI_MODEL", "gpt-4.1-mini"),
	})
}
