// Package anthropic adapts the Anthropic Messages API to scenario.LLM.
package anthropic

import (
	"context"
	"errors"

	"github.com/anthropics/anthropic-sdk-go"
	scenario "github.com/langwatch/scenario/go"
)

// DefaultMaxTokens is used when the request sets no limit; the Messages API
// requires one.
const DefaultMaxTokens = 4096

// Provider implements scenario.LLM with the Anthropic Go SDK.
type Provider struct {
	Client *anthropic.Client
}

// NewProvider wraps an Anthropic client.
func NewProvider(client *anthropic.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the Messages API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	resp, err := p.Client.Messages.New(ctx, toRequest(params))
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, errors.New("nil response from Anthropic")
	}
	return &scenario.InferenceResult{
		Message: fromAnthropicResponse(resp),
		Usage:   &scenario.Usage{InputTokens: resp.Usage.InputTokens, OutputTokens: resp.Usage.OutputTokens},
	}, nil
}

// toRequest converts scenario inference params to a Messages API request.
func toRequest(params scenario.InferenceParams) anthropic.MessageNewParams {
	system, rest := splitSystem(params.Messages)
	req := anthropic.MessageNewParams{
		Model:     anthropic.Model(params.Model),
		Messages:  ToAnthropicMessages(rest),
		MaxTokens: DefaultMaxTokens,
	}
	if len(system) > 0 {
		req.System = system
	}
	if params.Temperature != nil {
		req.Temperature = anthropic.Float(*params.Temperature)
	}
	if params.MaxTokens != nil {
		req.MaxTokens = *params.MaxTokens
	}
	if len(params.Tools) > 0 {
		req.Tools = toAnthropicTools(params.Tools)
	}
	if params.ToolChoice != nil {
		req.ToolChoice = toAnthropicToolChoice(params.ToolChoice)
	}
	return req
}
