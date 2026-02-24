package openai

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go"
)

// Provider implements scenario.Inference using the OpenAI Go SDK.
type Provider struct {
	Client *openai.Client
}

// NewProvider creates a new OpenAI provider wrapping the given client.
func NewProvider(client *openai.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the OpenAI chat completions API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	openaiParams := openai.ChatCompletionNewParams{
		Model:    params.Model,
		Messages: toOpenAIMessages(params.Messages),
	}

	if params.Temperature != nil {
		openaiParams.Temperature = openai.Opt(*params.Temperature)
	}
	if params.MaxTokens != nil {
		openaiParams.MaxCompletionTokens = openai.Opt(*params.MaxTokens)
	}
	if len(params.Tools) > 0 {
		openaiParams.Tools = toOpenAITools(params.Tools)
	}
	if params.ToolChoice != nil {
		openaiParams.ToolChoice = toOpenAIToolChoice(params.ToolChoice)
	}

	completion, err := p.Client.Chat.Completions.New(ctx, openaiParams)
	if err != nil {
		return nil, err
	}

	if len(completion.Choices) == 0 {
		return nil, errors.New("no response choices from OpenAI")
	}

	msg := fromOpenAIMessage(completion.Choices[0].Message)

	return &scenario.InferenceResult{
		Message: msg,
	}, nil
}
