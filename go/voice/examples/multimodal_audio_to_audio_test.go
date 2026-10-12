// Example: Multimodal Audio to Audio
//
// Like the audio-to-text example, but the agent answers with speech: the
// reply is an assistant message carrying the model's WAV audio and its
// transcript. The voice session added as an extension prepares both sides
// for the judge.
//
// Mirrors: javascript/examples/vitest/tests/multimodal-audio-to-audio.test.ts
package examples

import (
	"encoding/base64"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/openai/openai-go/v3"
)

// audioReply turns a spoken completion into an assistant audio message:
// the transcript as a text part, then the WAV.
func audioReply(a openai.ChatCompletionAudio) (*scenario.AgentReturn, error) {
	data, err := base64.StdEncoding.DecodeString(a.Data)
	if err != nil {
		return nil, err
	}
	var parts []scenario.Part
	if a.Transcript != "" {
		parts = append(parts, scenario.TextPart(a.Transcript))
	}
	parts = append(parts, scenario.AudioPart("audio/wav", data))
	return scenario.MessageReturn(scenario.Message{Role: scenario.RoleAssistant, Parts: parts}), nil
}

func TestMultimodalAudioToAudio(t *testing.T) {
	skipWithoutOpenAI(t)

	agent := &audioChatAgent{
		system: "You are a helpful assistant that can analyze audio input and respond with audio output. " +
			"You must respond with audio output.",
		speak: true,
	}

	res := run(t, scenario.ScenarioConfig{
		Name:        "multimodal audio to audio",
		Description: "User sends audio file, agent analyzes and transcribes the content",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: modelConfig()}),
			judge(),
		},
		Extensions: []scenario.Extension{voice.NewSession()},
		Script: []scenario.ScriptStep{
			scenario.MessageStep(audioQuestion(t, "Answer the question in the audio. "+
				"If you're not sure, you're required to take a best guess. "+
				"After you've guessed, you must repeat the question and say what format the input was in (audio or text)")),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(audioJudgeCriteria...)),
		},
		SetID: "multimodal-audio-test",
	})
	requireSuccess(t, res)
}
