package bedrock

import (
	"encoding/json"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// extractSystemMessages separates system messages from the rest,
// returning Bedrock system content blocks and the remaining messages.
func extractSystemMessages(msgs []scenario.Message) ([]types.SystemContentBlock, []scenario.Message) {
	var system []types.SystemContentBlock
	var remaining []scenario.Message

	for _, msg := range msgs {
		if msg.Role == scenario.MessageRoleSystem {
			system = append(system, &types.SystemContentBlockMemberText{
				Value: msg.Content,
			})
		} else {
			remaining = append(remaining, msg)
		}
	}

	return system, remaining
}

// ToBedrockMessages converts scenario messages to Bedrock message types.
// Exported for users who need to convert messages in their own agent adapters.
func ToBedrockMessages(msgs []scenario.Message) []types.Message {
	return toBedrockMessages(msgs)
}

func toBedrockMessages(msgs []scenario.Message) []types.Message {
	var result []types.Message

	for _, msg := range msgs {
		switch msg.Role {
		case scenario.MessageRoleUser:
			result = append(result, types.Message{
				Role: types.ConversationRoleUser,
				Content: []types.ContentBlock{
					&types.ContentBlockMemberText{Value: msg.Content},
				},
			})

		case scenario.MessageRoleAssistant:
			var blocks []types.ContentBlock
			if msg.Content != "" {
				blocks = append(blocks, &types.ContentBlockMemberText{Value: msg.Content})
			}
			for _, tc := range msg.ToolCalls {
				var input map[string]any
				if tc.Arguments != "" {
					_ = json.Unmarshal([]byte(tc.Arguments), &input)
				}
				if input == nil {
					input = map[string]any{}
				}
				blocks = append(blocks, &types.ContentBlockMemberToolUse{
					Value: types.ToolUseBlock{
						ToolUseId: aws.String(tc.ID),
						Name:      aws.String(tc.Name),
						Input:     document.NewLazyDocument(input),
					},
				})
			}
			if len(blocks) > 0 {
				result = append(result, types.Message{
					Role:    types.ConversationRoleAssistant,
					Content: blocks,
				})
			}

		case scenario.MessageRoleTool:
			result = append(result, types.Message{
				Role: types.ConversationRoleUser,
				Content: []types.ContentBlock{
					&types.ContentBlockMemberToolResult{
						Value: types.ToolResultBlock{
							ToolUseId: aws.String(msg.ToolCallID),
							Content: []types.ToolResultContentBlock{
								&types.ToolResultContentBlockMemberText{Value: msg.Content},
							},
						},
					},
				},
			})

		default:
			// Skip system (already extracted) and unknown roles
		}
	}

	return result
}

// fromBedrockMessage converts a Bedrock response Message to a scenario message.
func fromBedrockMessage(msg types.Message) scenario.Message {
	result := scenario.Message{
		Role: scenario.MessageRoleAssistant,
	}

	var textParts []string
	for _, block := range msg.Content {
		switch b := block.(type) {
		case *types.ContentBlockMemberText:
			textParts = append(textParts, b.Value)
		case *types.ContentBlockMemberToolUse:
			args := "{}"
			if b.Value.Input != nil {
				var parsed map[string]any
				if err := b.Value.Input.UnmarshalSmithyDocument(&parsed); err == nil {
					if encoded, err := json.Marshal(parsed); err == nil {
						args = string(encoded)
					}
				}
			}
			result.ToolCalls = append(result.ToolCalls, scenario.ToolCall{
				ID:        aws.ToString(b.Value.ToolUseId),
				Name:      aws.ToString(b.Value.Name),
				Arguments: args,
			})
		}
	}

	result.Content = strings.Join(textParts, "\n")

	return result
}

func toBedrockInferenceConfig(temperature *float64, maxTokens *int64) *types.InferenceConfiguration {
	if temperature == nil && maxTokens == nil {
		return nil
	}
	config := &types.InferenceConfiguration{}
	if temperature != nil {
		temp := float32(*temperature)
		config.Temperature = &temp
	}
	if maxTokens != nil {
		mt := int32(*maxTokens)
		config.MaxTokens = &mt
	}
	return config
}

func toBedrockToolConfig(tools []scenario.ToolDefinition, toolChoice *scenario.ToolChoice) *types.ToolConfiguration {
	config := &types.ToolConfiguration{}

	for _, tool := range tools {
		config.Tools = append(config.Tools, &types.ToolMemberToolSpec{
			Value: types.ToolSpecification{
				Name:        aws.String(tool.Name),
				Description: aws.String(tool.Description),
				InputSchema: &types.ToolInputSchemaMemberJson{
					Value: document.NewLazyDocument(tool.Parameters),
				},
			},
		})
	}

	if toolChoice != nil {
		switch toolChoice.Type {
		case "auto":
			config.ToolChoice = &types.ToolChoiceMemberAuto{Value: types.AutoToolChoice{}}
		case "required":
			config.ToolChoice = &types.ToolChoiceMemberAny{Value: types.AnyToolChoice{}}
		case "function":
			config.ToolChoice = &types.ToolChoiceMemberTool{
				Value: types.SpecificToolChoice{
					Name: aws.String(toolChoice.FunctionName),
				},
			}
		}
	}

	return config
}
