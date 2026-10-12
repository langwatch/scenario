//go:build integration

package anthropic_test

import (
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/langwatch/scenario/go/internal/livetest"
	scenarioanthropic "github.com/langwatch/scenario/go/providers/anthropic"
)

// TestLiveAnthropic runs the shared provider suite against the real
// Messages API. Needs ANTHROPIC_API_KEY; SCENARIO_LIVE_ANTHROPIC_MODEL
// overrides the model.
func TestLiveAnthropic(t *testing.T) {
	livetest.Require(t, "ANTHROPIC_API_KEY")
	client := anthropic.NewClient() // reads ANTHROPIC_API_KEY
	livetest.RunProviderSuite(t, livetest.Provider{
		Name:  "anthropic",
		LLM:   scenarioanthropic.NewProvider(&client),
		Model: livetest.Env("SCENARIO_LIVE_ANTHROPIC_MODEL", "claude-haiku-4-5"),
	})
}
