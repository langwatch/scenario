package gemini

import (
	"encoding/json"
	"fmt"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// extractSystemMessages separates system messages from the rest,
// returning a Gemini system instruction content and remaining messages.
func extractSystemMessages(msgs []scenario.Message) (*genai.Content, []scenario.Message) {
	var systemParts []*genai.Part
	var remaining []scenario.Message

	for _, msg := range msgs {
		if msg.Role == scenario.MessageRoleSystem {
			systemParts = append(systemParts, genai.NewPartFromText(msg.Content))
		} else {
			remaining = append(remaining, msg)
		}
	}

	if len(systemParts) == 0 {
		return nil, remaining
	}

	return &genai.Content{
		Parts: systemParts,
		Role:  "user",
	}, remaining
}

// ToGeminiContents converts scenario messages to Gemini content slices.
// Exported for users who need to convert messages in their own agent adapters.
func ToGeminiContents(msgs []scenario.Message) []*genai.Content {
	return toGeminiContents(msgs)
}

func toGeminiContents(msgs []scenario.Message) []*genai.Content {
	var result []*genai.Content

	for _, msg := range msgs {
		switch msg.Role {
		case scenario.MessageRoleUser:
			result = append(result, &genai.Content{
				Role:  "user",
				Parts: []*genai.Part{genai.NewPartFromText(msg.Content)},
			})

		case scenario.MessageRoleAssistant:
			var parts []*genai.Part
			if msg.Content != "" {
				parts = append(parts, genai.NewPartFromText(msg.Content))
			}
			for _, tc := range msg.ToolCalls {
				var args map[string]any
				if tc.Arguments != "" {
					_ = json.Unmarshal([]byte(tc.Arguments), &args)
				}
				if args == nil {
					args = map[string]any{}
				}
				parts = append(parts, &genai.Part{
					FunctionCall: &genai.FunctionCall{
						Name: tc.Name,
						Args: args,
					},
				})
			}
			if len(parts) > 0 {
				result = append(result, &genai.Content{
					Role:  "model",
					Parts: parts,
				})
			}

		case scenario.MessageRoleTool:
			var responseData map[string]any
			if msg.Content != "" {
				if err := json.Unmarshal([]byte(msg.Content), &responseData); err != nil {
					responseData = map[string]any{"result": msg.Content}
				}
			}
			result = append(result, &genai.Content{
				Role: "user",
				Parts: []*genai.Part{
					{
						FunctionResponse: &genai.FunctionResponse{
							Name:     msg.ToolCallID,
							Response: responseData,
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

// fromGeminiResponse converts a Gemini candidate to a scenario message.
func fromGeminiResponse(candidate *genai.Candidate) scenario.Message {
	msg := scenario.Message{
		Role: scenario.MessageRoleAssistant,
	}

	if candidate.Content == nil {
		return msg
	}

	var textParts []string
	for _, part := range candidate.Content.Parts {
		if part.Text != "" {
			textParts = append(textParts, part.Text)
		}
		if part.FunctionCall != nil {
			args := "{}"
			if part.FunctionCall.Args != nil {
				b, err := json.Marshal(part.FunctionCall.Args)
				if err == nil {
					args = string(b)
				}
			}
			msg.ToolCalls = append(msg.ToolCalls, scenario.ToolCall{
				ID:        part.FunctionCall.Name,
				Name:      part.FunctionCall.Name,
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

func toGeminiTools(tools []scenario.ToolDefinition) []*genai.Tool {
	var declarations []*genai.FunctionDeclaration
	for _, tool := range tools {
		schema := toGeminiSchema(tool.Parameters)
		declarations = append(declarations, &genai.FunctionDeclaration{
			Name:        tool.Name,
			Description: tool.Description,
			Parameters:  schema,
		})
	}
	return []*genai.Tool{
		{FunctionDeclarations: declarations},
	}
}

func toGeminiSchema(params map[string]any) *genai.Schema {
	if params == nil {
		return nil
	}

	schema := &genai.Schema{
		Type: genai.TypeObject,
	}

	if props, ok := params["properties"].(map[string]any); ok {
		schema.Properties = make(map[string]*genai.Schema)
		for name, propDef := range props {
			schema.Properties[name] = convertPropertyToSchema(propDef)
		}
	}

	if req, ok := params["required"].([]any); ok {
		for _, r := range req {
			if s, ok := r.(string); ok {
				schema.Required = append(schema.Required, s)
			}
		}
	}

	return schema
}

func convertPropertyToSchema(prop any) *genai.Schema {
	propMap, ok := prop.(map[string]any)
	if !ok {
		return &genai.Schema{Type: genai.TypeString}
	}

	schema := &genai.Schema{}

	if desc, ok := propMap["description"].(string); ok {
		schema.Description = desc
	}

	if enumVals, ok := propMap["enum"].([]any); ok {
		for _, v := range enumVals {
			schema.Enum = append(schema.Enum, fmt.Sprintf("%v", v))
		}
		schema.Type = genai.TypeString
		return schema
	}

	typStr, _ := propMap["type"].(string)
	switch typStr {
	case "string":
		schema.Type = genai.TypeString
	case "number":
		schema.Type = genai.TypeNumber
	case "integer":
		schema.Type = genai.TypeInteger
	case "boolean":
		schema.Type = genai.TypeBoolean
	case "array":
		schema.Type = genai.TypeArray
		if items, ok := propMap["items"]; ok {
			schema.Items = convertPropertyToSchema(items)
		}
	case "object":
		schema.Type = genai.TypeObject
		if props, ok := propMap["properties"].(map[string]any); ok {
			schema.Properties = make(map[string]*genai.Schema)
			for name, p := range props {
				schema.Properties[name] = convertPropertyToSchema(p)
			}
		}
		if req, ok := propMap["required"].([]any); ok {
			for _, r := range req {
				if s, ok := r.(string); ok {
					schema.Required = append(schema.Required, s)
				}
			}
		}
	default:
		schema.Type = genai.TypeString
	}

	return schema
}

func toGeminiToolConfig(tc *scenario.ToolChoice) *genai.ToolConfig {
	if tc == nil {
		return nil
	}

	config := &genai.ToolConfig{
		FunctionCallingConfig: &genai.FunctionCallingConfig{},
	}

	switch tc.Type {
	case "auto":
		config.FunctionCallingConfig.Mode = genai.FunctionCallingConfigModeAuto
	case "required":
		config.FunctionCallingConfig.Mode = genai.FunctionCallingConfigModeAny
	case "function":
		config.FunctionCallingConfig.Mode = genai.FunctionCallingConfigModeAny
		config.FunctionCallingConfig.AllowedFunctionNames = []string{tc.FunctionName}
	}

	return config
}

