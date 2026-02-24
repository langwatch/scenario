package openai

import (
	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go"
	"github.com/openai/openai-go/packages/param"
	"github.com/openai/openai-go/shared"
)

// ToOpenAIMessages converts scenario messages to OpenAI message params.
// Exported for users who need to convert messages in their own agent adapters.
func ToOpenAIMessages(msgs []scenario.Message) []openai.ChatCompletionMessageParamUnion {
	return toOpenAIMessages(msgs)
}

func toOpenAIMessages(msgs []scenario.Message) []openai.ChatCompletionMessageParamUnion {
	result := make([]openai.ChatCompletionMessageParamUnion, 0, len(msgs))
	for _, msg := range msgs {
		result = append(result, toOpenAIMessage(msg))
	}
	return result
}

func toOpenAIMessage(msg scenario.Message) openai.ChatCompletionMessageParamUnion {
	switch msg.Role {
	case scenario.MessageRoleSystem:
		return openai.SystemMessage(msg.Content)

	case scenario.MessageRoleUser:
		return openai.UserMessage(msg.Content)

	case scenario.MessageRoleAssistant:
		m := openai.AssistantMessage(msg.Content)
		if len(msg.ToolCalls) > 0 {
			toolCalls := make([]openai.ChatCompletionMessageToolCallParam, 0, len(msg.ToolCalls))
			for _, tc := range msg.ToolCalls {
				toolCalls = append(toolCalls, openai.ChatCompletionMessageToolCallParam{
					ID:   tc.ID,
					Type: "function",
					Function: openai.ChatCompletionMessageToolCallFunctionParam{
						Name:      tc.Name,
						Arguments: tc.Arguments,
					},
				})
			}
			m.OfAssistant.ToolCalls = toolCalls
		}
		return m

	case scenario.MessageRoleTool:
		return openai.ToolMessage(msg.ToolCallID, msg.Content)

	default:
		// Fallback: treat as user message
		return openai.UserMessage(msg.Content)
	}
}

// FromOpenAIMessages converts OpenAI message param unions to scenario messages.
// Exported for users who return openai messages from their AgentAdapter and need
// to convert them back to scenario messages.
func FromOpenAIMessages(msgs []openai.ChatCompletionMessageParamUnion) []scenario.Message {
	result := make([]scenario.Message, 0, len(msgs))
	for _, msg := range msgs {
		result = append(result, fromOpenAIMessageParam(msg))
	}
	return result
}

func fromOpenAIMessageParam(msg openai.ChatCompletionMessageParamUnion) scenario.Message {
	if msg.OfSystem != nil {
		return scenario.SystemMsg(extractSystemContent(msg.OfSystem))
	}
	if msg.OfUser != nil {
		return scenario.UserMsg(extractUserContent(msg.OfUser))
	}
	if msg.OfAssistant != nil {
		m := scenario.Message{
			Role:    scenario.MessageRoleAssistant,
			Content: extractAssistantContent(msg.OfAssistant),
		}
		for _, tc := range msg.OfAssistant.ToolCalls {
			m.ToolCalls = append(m.ToolCalls, scenario.ToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			})
		}
		return m
	}
	if msg.OfTool != nil {
		return scenario.ToolMsg(msg.OfTool.ToolCallID, extractToolContent(msg.OfTool))
	}
	return scenario.Message{}
}

// fromOpenAIMessage converts an OpenAI chat completion response message to a scenario message.
func fromOpenAIMessage(msg openai.ChatCompletionMessage) scenario.Message {
	m := scenario.Message{
		Role:    scenario.MessageRoleAssistant,
		Content: msg.Content,
	}
	for _, tc := range msg.ToolCalls {
		m.ToolCalls = append(m.ToolCalls, scenario.ToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: tc.Function.Arguments,
		})
	}
	return m
}

func toOpenAITools(tools []scenario.ToolDefinition) []openai.ChatCompletionToolParam {
	result := make([]openai.ChatCompletionToolParam, 0, len(tools))
	for _, tool := range tools {
		param := openai.ChatCompletionToolParam{
			Type: "function",
			Function: shared.FunctionDefinitionParam{
				Name:        tool.Name,
				Description: openai.Opt(tool.Description),
				Strict:      openai.Opt(tool.Strict),
				Parameters:  openai.FunctionParameters(tool.Parameters),
			},
		}
		result = append(result, param)
	}
	return result
}

func toOpenAIToolChoice(tc *scenario.ToolChoice) openai.ChatCompletionToolChoiceOptionUnionParam {
	if tc == nil {
		return openai.ChatCompletionToolChoiceOptionUnionParam{}
	}
	switch tc.Type {
	case "function":
		return openai.ChatCompletionToolChoiceOptionParamOfChatCompletionNamedToolChoice(
			openai.ChatCompletionNamedToolChoiceFunctionParam{
				Name: tc.FunctionName,
			},
		)
	case "auto":
		return openai.ChatCompletionToolChoiceOptionUnionParam{
			OfAuto: param.NewOpt("auto"),
		}
	case "required":
		return openai.ChatCompletionToolChoiceOptionUnionParam{
			OfAuto: param.NewOpt("required"),
		}
	default:
		return openai.ChatCompletionToolChoiceOptionUnionParam{}
	}
}

// --- Content extraction helpers ---

func extractSystemContent(msg *openai.ChatCompletionSystemMessageParam) string {
	if msg == nil {
		return ""
	}
	if msg.Content.OfString.Valid() {
		return msg.Content.OfString.Value
	}
	var text string
	for _, part := range msg.Content.OfArrayOfContentParts {
		text += part.Text
	}
	return text
}

func extractUserContent(msg *openai.ChatCompletionUserMessageParam) string {
	if msg == nil {
		return ""
	}
	if msg.Content.OfString.Valid() {
		return msg.Content.OfString.Value
	}
	var text string
	for _, part := range msg.Content.OfArrayOfContentParts {
		if part.OfText != nil {
			text += part.OfText.Text
		}
	}
	return text
}

func extractAssistantContent(msg *openai.ChatCompletionAssistantMessageParam) string {
	if msg == nil {
		return ""
	}
	if msg.Content.OfString.Valid() {
		return msg.Content.OfString.Value
	}
	var text string
	for _, part := range msg.Content.OfArrayOfContentParts {
		if part.OfText != nil {
			text += part.OfText.Text
		}
	}
	return text
}

func extractToolContent(msg *openai.ChatCompletionToolMessageParam) string {
	if msg == nil {
		return ""
	}
	if msg.Content.OfString.Valid() {
		return msg.Content.OfString.Value
	}
	var text string
	for _, part := range msg.Content.OfArrayOfContentParts {
		text += part.Text
	}
	return text
}
