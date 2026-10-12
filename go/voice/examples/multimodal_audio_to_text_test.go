// Example: Multimodal Audio to Text
//
// No voice transport at all: the user turn is a message carrying a WAV
// file next to a text instruction, sent with scenario.MessageStep, and the
// agent under test is an audio-capable chat model (gpt-audio-mini) that
// answers the spoken question. A voice.Session added as an extension gives
// the judge the same STT pre-pass a voice run has, so it reads what the
// audio said.
//
// Mirrors: javascript/examples/vitest/tests/multimodal-audio-to-text.test.ts
package examples

import (
	"context"
	"errors"
	"os"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
	"github.com/langwatch/scenario/go/voice"
	"github.com/openai/openai-go/v3"
)

// audioFixture is the JavaScript examples' fixture: a spoken question.
const audioFixture = "../../../javascript/examples/vitest/tests/fixtures/male_or_female_voice.wav"

// audioJudgeCriteria are worded defensively: a generic "I received your
// audio" or a polite "I can't process audio" must fail.
var audioJudgeCriteria = []string{
	"The agent's response demonstrates it processed the SPECIFIC content of the audio — it addresses or attempts to answer the actual question that was asked in the audio. A generic acknowledgement that audio was received (e.g. 'I got your audio file', 'I heard your message') does NOT satisfy this criterion on its own",
	"The agent provides a coherent, on-topic response — NOT an error message, NOT a refusal, NOT a polite deflection or claim that it cannot process audio / non-text input (e.g. 'I'm sorry, I can't listen to audio files'), and NOT an unrelated reply",
	"The agent's response indicates it received input in a non-text format, or that the question came via audio rather than text (exact phrasing does not matter)",
}

// audioQuestion is the user turn: an instruction and the fixture's audio.
func audioQuestion(t *testing.T, instruction string) scenario.Message {
	t.Helper()
	data, err := os.ReadFile(audioFixture)
	if err != nil {
		t.Fatal(err)
	}
	return scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{
		scenario.TextPart(instruction),
		scenario.AudioPart("audio/wav", data),
	}}
}

// audioChatAgent calls an audio-capable chat model with the conversation
// (audio parts become input_audio) and asks for text and spoken output.
type audioChatAgent struct {
	system string
	// speak returns the spoken reply as audio; otherwise its transcript.
	speak bool
}

func (a *audioChatAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *audioChatAgent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	msgs := in.Messages
	if a.system != "" {
		msgs = append([]scenario.Message{scenario.SystemMsg(a.system)}, msgs...)
	}
	client := openai.NewClient()
	resp, err := client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model:      "gpt-audio-mini",
		Modalities: []string{"text", "audio"},
		Audio: openai.ChatCompletionAudioParam{
			Voice:  openai.ChatCompletionAudioParamVoiceUnion{OfString: openai.String("alloy")},
			Format: openai.ChatCompletionAudioParamFormatWAV,
		},
		Messages: scenarioopenai.ToOpenAIMessages(msgs),
		Store:    openai.Bool(false),
	})
	if err != nil {
		return nil, err
	}
	if len(resp.Choices) == 0 {
		return nil, errors.New("the model returned no choice")
	}
	reply := resp.Choices[0].Message.Audio
	if !a.speak || reply.Data == "" {
		if reply.Transcript == "" {
			return nil, errors.New("the model returned neither audio nor a transcript")
		}
		return scenario.TextReturn(reply.Transcript), nil
	}
	return audioReply(reply)
}

func TestMultimodalAudioToText(t *testing.T) {
	skipWithoutOpenAI(t)

	res := run(t, scenario.ScenarioConfig{
		Name:        "multimodal audio to text",
		Description: "User sends audio file, agent analyzes and transcribes the content",
		Agents: []scenario.AgentAdapter{
			&audioChatAgent{},
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: modelConfig()}),
			judge(),
		},
		// Transcribes audio turns for the judge, as in a voice run.
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
