//go:build integration

package live_test

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/livetest"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go/v3"
)

// model is the cheap OpenAI model of the agents, the user simulators and
// the judges; SCENARIO_LIVE_OPENAI_MODEL overrides it.
func model() string { return livetest.Env("SCENARIO_LIVE_OPENAI_MODEL", "gpt-4.1-mini") }

// requireOpenAI skips without OPENAI_API_KEY and returns an OpenAI LLM.
func requireOpenAI(t testing.TB) scenario.LLM {
	t.Helper()
	livetest.Require(t, "OPENAI_API_KEY")
	client := openai.NewClient()
	return scenarioopenai.NewProvider(&client)
}

func modelConfig(llm scenario.LLM) scenario.ModelConfig {
	return scenario.ModelConfig{LLM: llm, Model: model()}
}

func userSimulator(llm scenario.LLM) *scenario.UserSimulatorAgent {
	return scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: modelConfig(llm)})
}

func judge(llm scenario.LLM, criteria ...string) *scenario.JudgeAgent {
	return scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: modelConfig(llm), Criteria: criteria})
}

func ptr[T any](v T) *T { return &v }
