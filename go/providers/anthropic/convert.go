package anthropic

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	scenario "github.com/langwatch/scenario/go"
)

// splitSystem moves system messages into Anthropic system blocks.
func splitSystem(msgs []scenario.Message) ([]anthropic.TextBlockParam, []scenario.Message) {
	var system []anthropic.TextBlockParam
	rest := make([]scenario.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == scenario.RoleSystem {
			system = append(system, anthropic.TextBlockParam{Text: m.Text()})
			continue
		}
		rest = append(rest, m)
	}
	return system, rest
}

// ToAnthropicMessages converts scenario messages to Anthropic message params.
// Consecutive user-side messages (user turns and tool results) merge into one
// user message, as the API expects alternating roles. Images and PDFs map to
// image and document blocks; Anthropic models take no audio input, so audio
// parts are dropped (an audio-only turn becomes "[audio message]").
func ToAnthropicMessages(msgs []scenario.Message) []anthropic.MessageParam {
	out := make([]anthropic.MessageParam, 0, len(msgs))
	appendBlocks := func(role anthropic.MessageParamRole, blocks []anthropic.ContentBlockParamUnion) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, anthropic.MessageParam{Role: role, Content: blocks})
	}
	for _, m := range msgs {
		switch m.Role {
		case scenario.RoleUser:
			appendBlocks(anthropic.MessageParamRoleUser, contentBlocks(m))
		case scenario.RoleTool:
			appendBlocks(anthropic.MessageParamRoleUser, []anthropic.ContentBlockParamUnion{
				anthropic.NewToolResultBlock(m.ToolCallID, m.Text(), m.IsError),
			})
		case scenario.RoleAssistant:
			blocks := contentBlocks(m)
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, anthropic.NewToolUseBlock(tc.ID, toolInput(tc.Arguments), tc.Name))
			}
			appendBlocks(anthropic.MessageParamRoleAssistant, blocks)
		}
	}
	return out
}

func contentBlocks(m scenario.Message) []anthropic.ContentBlockParamUnion {
	if len(m.Parts) == 0 {
		if m.Content == "" {
			return nil
		}
		return []anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(m.Content)}
	}
	var blocks []anthropic.ContentBlockParamUnion
	audioOnly := true
	for _, p := range m.Parts {
		switch {
		case p.Type == scenario.PartText:
			audioOnly = false
			if p.Text != "" {
				blocks = append(blocks, anthropic.NewTextBlock(p.Text))
			}
		case p.Type == scenario.PartImage && p.URL != "":
			audioOnly = false
			blocks = append(blocks, anthropic.NewImageBlock(anthropic.URLImageSourceParam{URL: p.URL}))
		case p.Type == scenario.PartImage:
			audioOnly = false
			blocks = append(blocks, anthropic.NewImageBlockBase64(p.MediaType, base64.StdEncoding.EncodeToString(p.Data)))
		case p.Type == scenario.PartFile && p.MediaType == "application/pdf" && len(p.Data) > 0:
			audioOnly = false
			blocks = append(blocks, anthropic.NewDocumentBlock(anthropic.Base64PDFSourceParam{Data: base64.StdEncoding.EncodeToString(p.Data)}))
		case !p.IsAudio():
			audioOnly = false
		}
	}
	if len(blocks) == 0 && audioOnly {
		blocks = append(blocks, anthropic.NewTextBlock("[audio message]"))
	}
	return blocks
}

func toolInput(args string) any {
	var v any
	if args == "" || json.Unmarshal([]byte(args), &v) != nil {
		return map[string]any{}
	}
	return v
}

// fromAnthropicResponse converts a response; text blocks join with newlines.
func fromAnthropicResponse(resp *anthropic.Message) scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant}
	var texts []string
	for _, block := range resp.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				texts = append(texts, block.Text)
			}
		case "tool_use":
			args := string(block.Input)
			if args == "" {
				args = "{}"
			}
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: block.ID, Name: block.Name, Arguments: args})
		}
	}
	out.Content = strings.Join(texts, "\n")
	return out
}

func toAnthropicTools(tools []scenario.ToolDefinition) []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(tools))
	for _, t := range tools {
		schema := anthropic.ToolInputSchemaParam{Properties: t.Parameters["properties"]}
		if req, ok := t.Parameters["required"].([]any); ok {
			for _, r := range req {
				if s, ok := r.(string); ok {
					schema.Required = append(schema.Required, s)
				}
			}
		}
		for k, v := range t.Parameters {
			if k != "type" && k != "properties" && k != "required" {
				if schema.ExtraFields == nil {
					schema.ExtraFields = map[string]any{}
				}
				schema.ExtraFields[k] = v
			}
		}
		tool := &anthropic.ToolParam{Name: t.Name, InputSchema: schema}
		if t.Description != "" {
			tool.Description = anthropic.String(t.Description)
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: tool})
	}
	return out
}

func toAnthropicToolChoice(tc *scenario.ToolChoice) anthropic.ToolChoiceUnionParam {
	switch tc.Type {
	case scenario.ToolChoiceAuto:
		return anthropic.ToolChoiceUnionParam{OfAuto: &anthropic.ToolChoiceAutoParam{}}
	case scenario.ToolChoiceRequired:
		return anthropic.ToolChoiceUnionParam{OfAny: &anthropic.ToolChoiceAnyParam{}}
	case scenario.ToolChoiceNone:
		return anthropic.ToolChoiceUnionParam{OfNone: &anthropic.ToolChoiceNoneParam{}}
	case scenario.ToolChoiceTool:
		return anthropic.ToolChoiceUnionParam{OfTool: &anthropic.ToolChoiceToolParam{Name: tc.ToolName}}
	}
	return anthropic.ToolChoiceUnionParam{}
}
