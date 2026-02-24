package anthropic

import (
	"encoding/json"

	scenario "github.com/langwatch/scenario/go"
	"github.com/anthropics/anthropic-sdk-go"
)

// extractSystemMessages separates system messages from the rest,
// returning Anthropic system blocks and the remaining messages.
func extractSystemMessages(msgs []scenario.Message) ([]anthropic.TextBlockParam, []scenario.Message) {
	var systemBlocks []anthropic.TextBlockParam
	var remaining []scenario.Message

	for _, msg := range msgs {
		if msg.Role == scenario.MessageRoleSystem {
			systemBlocks = append(systemBlocks, anthropic.TextBlockParam{Text: msg.Content})
		} else {
			remaining = append(remaining, msg)
		}
	}

	return systemBlocks, remaining
}

// ToAnthropicMessages converts scenario messages to Anthropic message params.
// Exported for users who need to convert messages in their own agent adapters.
func ToAnthropicMessages(msgs []scenario.Message) []anthropic.MessageParam {
	return toAnthropicMessages(msgs)
}

func toAnthropicMessages(msgs []scenario.Message) []anthropic.MessageParam {
	result := make([]anthropic.MessageParam, 0, len(msgs))

	for _, msg := range msgs {
		switch msg.Role {
		case scenario.MessageRoleUser:
			result = append(result, anthropic.NewUserMessage(
				anthropic.ContentBlockParamUnion{
					OfText: &anthropic.TextBlockParam{Text: msg.Content},
				},
			))

		case scenario.MessageRoleAssistant:
			var blocks []anthropic.ContentBlockParamUnion
			if msg.Content != "" {
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfText: &anthropic.TextBlockParam{Text: msg.Content},
				})
			}
			for _, tc := range msg.ToolCalls {
				var input any
				if tc.Arguments != "" {
					var parsed map[string]any
					if err := json.Unmarshal([]byte(tc.Arguments), &parsed); err == nil {
						input = parsed
					} else {
						input = map[string]any{}
					}
				} else {
					input = map[string]any{}
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfToolUse: &anthropic.ToolUseBlockParam{
						ID:    tc.ID,
						Name:  tc.Name,
						Input: input,
					},
				})
			}
			if len(blocks) > 0 {
				result = append(result, anthropic.NewAssistantMessage(blocks...))
			}

		case scenario.MessageRoleTool:
			result = append(result, anthropic.NewUserMessage(
				anthropic.ContentBlockParamUnion{
					OfToolResult: &anthropic.ToolResultBlockParam{
						ToolUseID: msg.ToolCallID,
						Content: []anthropic.ToolResultBlockParamContentUnion{
							{OfText: &anthropic.TextBlockParam{Text: msg.Content}},
						},
					},
				},
			))

		default:
			// Skip system (already extracted) and unknown roles
		}
	}

	return result
}

// fromAnthropicResponse converts an Anthropic API response to a scenario message.
func fromAnthropicResponse(resp *anthropic.Message) scenario.Message {
	msg := scenario.Message{
		Role: scenario.MessageRoleAssistant,
	}

	var textParts []string
	for _, block := range resp.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use":
			args := "{}"
			if block.Input != nil {
				b, err := json.Marshal(block.Input)
				if err == nil {
					args = string(b)
				}
			}
			msg.ToolCalls = append(msg.ToolCalls, scenario.ToolCall{
				ID:        block.ID,
				Name:      block.Name,
				Arguments: args,
			})
		}
	}

	if len(textParts) > 0 {
		for i, part := range textParts {
			if i > 0 {
				msg.Content += "\n"
			}
			msg.Content += part
		}
	}

	return msg
}

func toAnthropicTools(tools []scenario.ToolDefinition) []anthropic.ToolUnionParam {
	result := make([]anthropic.ToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		tp := &anthropic.ToolParam{
			Name:        tool.Name,
			Description: anthropic.String(tool.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: tool.Parameters["properties"],
			},
		}
		if req, ok := tool.Parameters["required"].([]any); ok {
			reqStrings := make([]string, 0, len(req))
			for _, r := range req {
				if s, ok := r.(string); ok {
					reqStrings = append(reqStrings, s)
				}
			}
			tp.InputSchema.Required = reqStrings
		}
		result = append(result, anthropic.ToolUnionParam{OfTool: tp})
	}
	return result
}

func toAnthropicToolChoice(tc *scenario.ToolChoice) anthropic.ToolChoiceUnionParam {
	if tc == nil {
		return anthropic.ToolChoiceUnionParam{}
	}
	switch tc.Type {
	case "auto":
		return anthropic.ToolChoiceUnionParam{
			OfAuto: &anthropic.ToolChoiceAutoParam{},
		}
	case "required":
		return anthropic.ToolChoiceUnionParam{
			OfAny: &anthropic.ToolChoiceAnyParam{},
		}
	case "function":
		return anthropic.ToolChoiceUnionParam{
			OfTool: &anthropic.ToolChoiceToolParam{
				Name: tc.FunctionName,
			},
		}
	default:
		return anthropic.ToolChoiceUnionParam{}
	}
}
