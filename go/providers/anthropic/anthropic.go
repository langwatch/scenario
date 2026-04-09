package anthropic

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"github.com/anthropics/anthropic-sdk-go"
)

// Provider implements scenario.Inference using the Anthropic Go SDK.
type Provider struct {
	Client *anthropic.Client
}

// NewProvider creates a new Anthropic provider wrapping the given client.
func NewProvider(client *anthropic.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the Anthropic messages API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	systemBlocks, messages := extractSystemMessages(params.Messages)

	anthropicParams := anthropic.MessageNewParams{
		Model:    anthropic.Model(params.Model),
		Messages: toAnthropicMessages(messages),
	}

	if len(systemBlocks) > 0 {
		anthropicParams.System = systemBlocks
	}

	if params.Temperature != nil {
		anthropicParams.Temperature = anthropic.Float(*params.Temperature)
	}

	maxTokens := int64(4096)
	if params.MaxTokens != nil {
		maxTokens = *params.MaxTokens
	}
	anthropicParams.MaxTokens = maxTokens

	if len(params.Tools) > 0 {
		anthropicParams.Tools = toAnthropicTools(params.Tools)
	}
	if params.ToolChoice != nil {
		anthropicParams.ToolChoice = toAnthropicToolChoice(params.ToolChoice)
	}

	response, err := p.Client.Messages.New(ctx, anthropicParams)
	if err != nil {
		return nil, err
	}

	if response == nil {
		return nil, errors.New("nil response from Anthropic")
	}

	msg := fromAnthropicResponse(response)

	return &scenario.InferenceResult{
		Message: msg,
	}, nil
}
