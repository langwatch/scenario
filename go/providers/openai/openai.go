// Package openai adapts the OpenAI Chat Completions API to scenario.LLM.
package openai

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
)

// Provider implements scenario.LLM with the OpenAI Go SDK.
type Provider struct {
	Client *openai.Client
}

// NewProvider wraps an OpenAI client.
func NewProvider(client *openai.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the chat completions API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	req := openai.ChatCompletionNewParams{
		Model:    params.Model,
		Messages: ToOpenAIMessages(params.Messages),
	}
	if params.Temperature != nil {
		req.Temperature = openai.Float(*params.Temperature)
	}
	if params.MaxTokens != nil {
		req.MaxCompletionTokens = openai.Int(*params.MaxTokens)
	}
	if len(params.Tools) > 0 {
		req.Tools = toOpenAITools(params.Tools)
	}
	if params.ToolChoice != nil {
		req.ToolChoice = toOpenAIToolChoice(params.ToolChoice)
	}
	completion, err := p.Client.Chat.Completions.New(ctx, req)
	if err != nil {
		return nil, err
	}
	if len(completion.Choices) == 0 {
		return nil, errors.New("no response choices from OpenAI")
	}
	return &scenario.InferenceResult{
		Message: fromOpenAIMessage(completion.Choices[0].Message),
		Usage:   &scenario.Usage{InputTokens: completion.Usage.PromptTokens, OutputTokens: completion.Usage.CompletionTokens},
	}, nil
}
