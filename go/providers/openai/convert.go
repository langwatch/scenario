package openai

import (
	"encoding/base64"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/shared"
)

// ToOpenAIMessages converts scenario messages to OpenAI message params,
// for agent adapters that call OpenAI themselves. User content parts map to
// text, image, input_audio (WAV/MP3; raw PCM16 is wrapped in WAV) and file
// parts.
func ToOpenAIMessages(msgs []scenario.Message) []openai.ChatCompletionMessageParamUnion {
	out := make([]openai.ChatCompletionMessageParamUnion, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, toOpenAIMessage(m))
	}
	return out
}

func toOpenAIMessage(m scenario.Message) openai.ChatCompletionMessageParamUnion {
	switch m.Role {
	case scenario.RoleSystem:
		return openai.SystemMessage(m.Text())
	case scenario.RoleAssistant:
		msg := openai.AssistantMessage(m.Text())
		for _, tc := range m.ToolCalls {
			msg.OfAssistant.ToolCalls = append(msg.OfAssistant.ToolCalls, openai.ChatCompletionMessageToolCallUnionParam{
				OfFunction: &openai.ChatCompletionMessageFunctionToolCallParam{
					ID:       tc.ID,
					Function: openai.ChatCompletionMessageFunctionToolCallFunctionParam{Name: tc.Name, Arguments: tc.Arguments},
				},
			})
		}
		return msg
	case scenario.RoleTool:
		return openai.ToolMessage(m.Text(), m.ToolCallID)
	}
	if len(m.Parts) == 0 {
		return openai.UserMessage(m.Content)
	}
	parts := make([]openai.ChatCompletionContentPartUnionParam, 0, len(m.Parts))
	for _, p := range m.Parts {
		if part, ok := toOpenAIPart(p); ok {
			parts = append(parts, part)
		}
	}
	return openai.UserMessage(parts)
}

func toOpenAIPart(p scenario.Part) (openai.ChatCompletionContentPartUnionParam, bool) {
	switch {
	case p.Type == scenario.PartText:
		return openai.TextContentPart(p.Text), true
	case p.Type == scenario.PartImage:
		url := p.URL
		if url == "" {
			mt := p.MediaType
			if mt == "" {
				mt = "image/png"
			}
			url = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(p.Data)
		}
		return openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{URL: url}), true
	case p.IsAudio() && len(p.Data) > 0:
		data, format := p.Data, audioFormat(p.MediaType)
		if p.MediaType == scenario.MediaTypePCM16 {
			data, format = scenario.WAVFromPCM16(p.Data), "wav"
		}
		if format == "" {
			return openai.ChatCompletionContentPartUnionParam{}, false
		}
		return openai.InputAudioContentPart(openai.ChatCompletionContentPartInputAudioInputAudioParam{
			Data: base64.StdEncoding.EncodeToString(data), Format: format,
		}), true
	case p.Type == scenario.PartFile && len(p.Data) > 0:
		name := p.Filename
		if name == "" {
			name = "file"
		}
		return openai.FileContentPart(openai.ChatCompletionContentPartFileFileParam{
			FileData: openai.String("data:" + p.MediaType + ";base64," + base64.StdEncoding.EncodeToString(p.Data)),
			Filename: openai.String(name),
		}), true
	}
	return openai.ChatCompletionContentPartUnionParam{}, false
}

func audioFormat(mediaType string) string {
	switch strings.ToLower(mediaType) {
	case "audio/wav", "audio/x-wav", "audio/wave":
		return "wav"
	case "audio/mpeg", "audio/mp3":
		return "mp3"
	}
	return ""
}

// FromOpenAIMessages converts OpenAI message params back to scenario
// messages, for adapters that keep OpenAI-typed histories.
func FromOpenAIMessages(msgs []openai.ChatCompletionMessageParamUnion) []scenario.Message {
	out := make([]scenario.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, fromOpenAIParam(m))
	}
	return out
}

func fromOpenAIParam(m openai.ChatCompletionMessageParamUnion) scenario.Message {
	switch {
	case m.OfSystem != nil:
		return scenario.SystemMsg(textOf(m.OfSystem.Content.OfString.Value, m.OfSystem.Content.OfArrayOfContentParts))
	case m.OfUser != nil:
		if m.OfUser.Content.OfString.Valid() {
			return scenario.UserMsg(m.OfUser.Content.OfString.Value)
		}
		var parts []scenario.Part
		for _, p := range m.OfUser.Content.OfArrayOfContentParts {
			switch {
			case p.OfText != nil:
				parts = append(parts, scenario.TextPart(p.OfText.Text))
			case p.OfImageURL != nil:
				parts = append(parts, scenario.ImageURLPart(p.OfImageURL.ImageURL.URL))
			case p.OfInputAudio != nil:
				data, _ := base64.StdEncoding.DecodeString(p.OfInputAudio.InputAudio.Data)
				parts = append(parts, scenario.AudioPart("audio/"+p.OfInputAudio.InputAudio.Format, data))
			}
		}
		return scenario.Message{Role: scenario.RoleUser, Parts: parts}
	case m.OfAssistant != nil:
		out := scenario.Message{Role: scenario.RoleAssistant}
		if m.OfAssistant.Content.OfString.Valid() {
			out.Content = m.OfAssistant.Content.OfString.Value
		} else {
			var b strings.Builder
			for _, p := range m.OfAssistant.Content.OfArrayOfContentParts {
				if p.OfText != nil {
					b.WriteString(p.OfText.Text)
				}
			}
			out.Content = b.String()
		}
		for _, tc := range m.OfAssistant.ToolCalls {
			if tc.OfFunction != nil {
				out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: tc.OfFunction.ID, Name: tc.OfFunction.Function.Name, Arguments: tc.OfFunction.Function.Arguments})
			}
		}
		return out
	case m.OfTool != nil:
		return scenario.ToolMsg(m.OfTool.ToolCallID, textOf(m.OfTool.Content.OfString.Value, m.OfTool.Content.OfArrayOfContentParts))
	}
	return scenario.Message{}
}

func textOf(s string, parts []openai.ChatCompletionContentPartTextParam) string {
	if s != "" || len(parts) == 0 {
		return s
	}
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String()
}

// fromOpenAIMessage converts a completion message, including spoken audio
// output of audio models.
func fromOpenAIMessage(m openai.ChatCompletionMessage) scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant, Content: m.Content}
	if m.Audio.Data != "" {
		if data, err := base64.StdEncoding.DecodeString(m.Audio.Data); err == nil {
			text := m.Content
			if text == "" {
				text = m.Audio.Transcript
			}
			out.Content = ""
			if text != "" {
				out.Parts = append(out.Parts, scenario.TextPart(text))
			}
			out.Parts = append(out.Parts, scenario.AudioPart("audio/wav", data))
		}
	}
	for _, tc := range m.ToolCalls {
		out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: tc.Function.Arguments})
	}
	return out
}

func toOpenAITools(tools []scenario.ToolDefinition) []openai.ChatCompletionToolUnionParam {
	out := make([]openai.ChatCompletionToolUnionParam, 0, len(tools))
	for _, t := range tools {
		def := shared.FunctionDefinitionParam{
			Name:       t.Name,
			Parameters: shared.FunctionParameters(t.Parameters),
		}
		if t.Description != "" {
			def.Description = openai.String(t.Description)
		}
		if t.Strict {
			def.Strict = openai.Bool(true)
		}
		out = append(out, openai.ChatCompletionFunctionTool(def))
	}
	return out
}

func toOpenAIToolChoice(tc *scenario.ToolChoice) openai.ChatCompletionToolChoiceOptionUnionParam {
	switch tc.Type {
	case scenario.ToolChoiceTool:
		return openai.ToolChoiceOptionFunctionToolChoice(openai.ChatCompletionNamedToolChoiceFunctionParam{Name: tc.ToolName})
	case scenario.ToolChoiceAuto, scenario.ToolChoiceRequired, scenario.ToolChoiceNone:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.String(string(tc.Type))}
	}
	return openai.ChatCompletionToolChoiceOptionUnionParam{}
}
