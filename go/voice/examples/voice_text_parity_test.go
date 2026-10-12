// Example: Voice and Text Parity
//
// Voice is not a separate paradigm: the same script and judge run through
// the same scenario.Run against a text agent and a voice agent. Only the
// agents differ. The text run records no audio (voice.ResultOf returns
// nil); the voice run does. Both must pass.
//
// Mirrors: javascript/examples/vitest/tests/voice/voice-text-parity.test.ts
package examples

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
)

var parityCriteria = []string{
	"The agent responded helpfully and on-topic to the user's greeting",
	"The agent's reply is coherent and conversational",
}

// parityScript is shared by both runs.
func parityScript() []scenario.ScriptStep {
	return []scenario.ScriptStep{
		scenario.User("Hello, can you help me?"),
		scenario.Agent(),
		scenario.User("Great — what can you do?"),
		scenario.Agent(),
		scenario.Judge(),
	}
}

// cannedTextAgent answers from a fixed script.
type cannedTextAgent struct{ turn int }

func (a *cannedTextAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *cannedTextAgent) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	a.turn++
	if a.turn == 1 {
		return scenario.TextReturn("Hi there! I'm happy to help. What do you need?"), nil
	}
	return scenario.TextReturn("Happy to help with that — I can answer questions, look things up, and " +
		"walk you through next steps. What would you like to start with?"), nil
}

func TestVoiceTextParity(t *testing.T) {
	skipWithoutOpenAI(t)

	textRes := run(t, scenario.ScenarioConfig{
		Name:        "parity_text",
		Description: "Text-only control: same script and judge, no voice.",
		Agents: []scenario.AgentAdapter{
			&cannedTextAgent{},
			// No voice: a plain text user simulator.
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: modelConfig()}),
			judge(parityCriteria...),
		},
		Script:   parityScript(),
		MaxTurns: 6,
	})

	voiceRes := run(t, scenario.ScenarioConfig{
		Name:        "parity_voice",
		Description: "Voice path: OpenAI Realtime agent + voice user simulator, same judge.",
		Agents: []scenario.AgentAdapter{
			openairealtime.New(openairealtime.Options{
				Voice:        "alloy",
				Instructions: "You are a helpful assistant. Keep responses brief.",
			}),
			voiceUser("openai/nova", ""),
			judge(parityCriteria...),
		},
		Script:   parityScript(),
		MaxTurns: 6,
	})

	requireSuccess(t, textRes)
	requireSuccess(t, voiceRes)
	if voice.ResultOf(textRes) != nil {
		t.Error("the text-only run produced a voice result")
	}
	rec := voiceResult(t, voiceRes).Recording
	if len(rec.Segments) == 0 {
		t.Error("the voice run recorded no segments")
	}
	saveRecording(t, rec, "voice_text_parity")
}
