// Example: Multilingual Agent
//
// Scripted translations between English, French, Spanish, Chinese and German,
// judged on accuracy and on preserving punctuation and emojis.
//
// Mirrors: javascript/examples/vitest/tests/multilingual-agent.test.ts
package examples

import (
	"context"
	"os"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMultilingualAgent_ComplexTranslations(t *testing.T) {
	// A nondeterministic, model-graded translation check: run it locally,
	// not on the CI gate.
	if os.Getenv("CI") == "true" {
		t.Skip("skipped in CI")
	}
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Complex multi-language translations with punctuation and emojis",
		Description: "As the user, you want to get a translations of complex text—with varied punctuation and emojis—accurately between supported languages.",
		Agents: []scenario.AgentAdapter{
			simpleAgent("You are a translation assistant for English, French, Spanish, Chinese and German.", nil, nil),
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User(`Translate to Spanish: "Hello world! 😊 How are you today?"`),
			scenario.Agent(),
			scenario.User(`Traduire en chinois: "Bonjour le monde! 😊 Comment allez-vous aujourd'hui?"`),
			scenario.Agent(),
			scenario.User(`Übersetzen Sie ins Englische: "Guten Morgen! ☕️ Haben Sie einen schönen Tag?"`),
			scenario.Agent(),
			scenario.User(`翻译成德语: "你好世界！😊 今天过得怎么样？"`),
			scenario.Agent(),
			scenario.User("Do all of the permutations for the supported languages at once"),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"Translation is accurate",
				"Translation preserves original meaning",
				"Translation preserves punctuation",
				"Translation preserves emojis",
				"Response remains in the language of the original request",
				"Agent handles translation requests among English, French, Spanish, Chinese, and German",
			)),
		},
		SetID: "multilingual-scripted-complex",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
