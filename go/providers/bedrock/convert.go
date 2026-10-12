package bedrock

import (
	"encoding/json"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

func splitSystem(msgs []scenario.Message) ([]types.SystemContentBlock, []scenario.Message) {
	var system []types.SystemContentBlock
	rest := make([]scenario.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == scenario.RoleSystem {
			system = append(system, &types.SystemContentBlockMemberText{Value: m.Text()})
			continue
		}
		rest = append(rest, m)
	}
	return system, rest
}

// ToBedrockMessages converts scenario messages to Converse messages.
// Consecutive user-side messages (user turns and tool results) merge, as
// Converse requires alternating roles. Images and documents map to image and
// document blocks; Converse takes no audio, so audio parts are dropped (an
// audio-only turn becomes "[audio message]").
func ToBedrockMessages(msgs []scenario.Message) []types.Message {
	out := make([]types.Message, 0, len(msgs))
	add := func(role types.ConversationRole, blocks []types.ContentBlock) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, types.Message{Role: role, Content: blocks})
	}
	for _, m := range msgs {
		switch m.Role {
		case scenario.RoleUser:
			add(types.ConversationRoleUser, contentBlocks(m))
		case scenario.RoleTool:
			result := types.ToolResultBlock{
				ToolUseId: aws.String(m.ToolCallID),
				Content:   []types.ToolResultContentBlock{&types.ToolResultContentBlockMemberText{Value: m.Text()}},
			}
			if m.IsError {
				result.Status = types.ToolResultStatusError
			}
			add(types.ConversationRoleUser, []types.ContentBlock{&types.ContentBlockMemberToolResult{Value: result}})
		case scenario.RoleAssistant:
			blocks := contentBlocks(m)
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, &types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{
					ToolUseId: aws.String(tc.ID),
					Name:      aws.String(tc.Name),
					Input:     document.NewLazyDocument(argsMap(tc.Arguments)),
				}})
			}
			add(types.ConversationRoleAssistant, blocks)
		}
	}
	return out
}

func contentBlocks(m scenario.Message) []types.ContentBlock {
	if len(m.Parts) == 0 {
		if m.Content == "" {
			return nil
		}
		return []types.ContentBlock{&types.ContentBlockMemberText{Value: m.Content}}
	}
	var blocks []types.ContentBlock
	audioOnly := true
	for _, p := range m.Parts {
		switch {
		case p.Type == scenario.PartText:
			audioOnly = false
			if p.Text != "" {
				blocks = append(blocks, &types.ContentBlockMemberText{Value: p.Text})
			}
		case p.Type == scenario.PartImage && len(p.Data) > 0:
			audioOnly = false
			blocks = append(blocks, &types.ContentBlockMemberImage{Value: types.ImageBlock{
				Format: types.ImageFormat(subtype(p.MediaType)),
				Source: &types.ImageSourceMemberBytes{Value: p.Data},
			}})
		case p.Type == scenario.PartFile && !p.IsAudio() && len(p.Data) > 0:
			audioOnly = false
			name := p.Filename
			if name == "" {
				name = "document"
			}
			blocks = append(blocks, &types.ContentBlockMemberDocument{Value: types.DocumentBlock{
				Format: types.DocumentFormat(subtype(p.MediaType)),
				Name:   aws.String(name),
				Source: &types.DocumentSourceMemberBytes{Value: p.Data},
			}})
		case !p.IsAudio():
			audioOnly = false
		}
	}
	if len(blocks) == 0 && audioOnly {
		blocks = append(blocks, &types.ContentBlockMemberText{Value: "[audio message]"})
	}
	return blocks
}

// subtype returns the part after "/" of a media type ("image/png" → "png").
func subtype(mediaType string) string {
	_, sub, _ := strings.Cut(mediaType, "/")
	return sub
}

func argsMap(args string) map[string]any {
	var v map[string]any
	if args == "" || json.Unmarshal([]byte(args), &v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}

func fromBedrockMessage(msg types.Message) scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant}
	var texts []string
	for _, block := range msg.Content {
		switch b := block.(type) {
		case *types.ContentBlockMemberText:
			texts = append(texts, b.Value)
		case *types.ContentBlockMemberToolUse:
			args := "{}"
			// MarshalSmithyDocument yields the JSON as sent; decoding into
			// any would turn numbers into strings.
			if b.Value.Input != nil {
				if enc, err := b.Value.Input.MarshalSmithyDocument(); err == nil && len(enc) > 0 {
					args = string(enc)
				}
			}
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: aws.ToString(b.Value.ToolUseId), Name: aws.ToString(b.Value.Name), Arguments: args})
		}
	}
	out.Content = strings.Join(texts, "\n")
	return out
}

func toInferenceConfig(temperature *float64, maxTokens *int64) *types.InferenceConfiguration {
	if temperature == nil && maxTokens == nil {
		return nil
	}
	cfg := &types.InferenceConfiguration{}
	if temperature != nil {
		cfg.Temperature = aws.Float32(float32(*temperature))
	}
	if maxTokens != nil {
		cfg.MaxTokens = aws.Int32(int32(*maxTokens))
	}
	return cfg
}

// toToolConfig normalizes each schema through JSON first: smithy documents
// cannot encode pre-encoded JSON values the core uses for ordered schemas.
func toToolConfig(tools []scenario.ToolDefinition, choice *scenario.ToolChoice) (*types.ToolConfiguration, error) {
	cfg := &types.ToolConfiguration{}
	for _, t := range tools {
		raw, err := json.Marshal(t.Parameters)
		if err != nil {
			return nil, err
		}
		var schema any
		if err := json.Unmarshal(raw, &schema); err != nil {
			return nil, err
		}
		spec := types.ToolSpecification{
			Name:        aws.String(t.Name),
			InputSchema: &types.ToolInputSchemaMemberJson{Value: document.NewLazyDocument(schema)},
		}
		if t.Description != "" {
			spec.Description = aws.String(t.Description)
		}
		cfg.Tools = append(cfg.Tools, &types.ToolMemberToolSpec{Value: spec})
	}
	if choice != nil {
		switch choice.Type {
		case scenario.ToolChoiceAuto:
			cfg.ToolChoice = &types.ToolChoiceMemberAuto{Value: types.AutoToolChoice{}}
		case scenario.ToolChoiceRequired:
			cfg.ToolChoice = &types.ToolChoiceMemberAny{Value: types.AnyToolChoice{}}
		case scenario.ToolChoiceTool:
			cfg.ToolChoice = &types.ToolChoiceMemberTool{Value: types.SpecificToolChoice{Name: aws.String(choice.ToolName)}}
		}
	}
	return cfg, nil
}
