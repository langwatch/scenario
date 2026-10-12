// Package openai adapts the OpenAI Chat Completions API to scenario.LLM,
// for OpenAI itself, Azure OpenAI and OpenAI-compatible servers (OpenRouter,
// Ollama, Groq, Together, vLLM, a LiteLLM proxy, Mistral, …).
package openai

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// Provider implements scenario.LLM with the OpenAI Go SDK.
type Provider struct {
	Client *openai.Client
	// RequestOptions are applied to every request, after the client's own.
	RequestOptions []option.RequestOption
	// LegacyParams sends only long-standing request fields, for
	// OpenAI-compatible servers that reject newer ones: the token limit as
	// max_tokens instead of max_completion_tokens, and Stream asks for no
	// usage chunk (stream_options).
	LegacyParams bool
	// perModel adds request options that depend on the model, such as the
	// deployment path of Azure's deployments API.
	perModel func(model string) []option.RequestOption
}

// NewProvider wraps an OpenAI client.
func NewProvider(client *openai.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the chat completions API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	completion, err := p.Client.Chat.Completions.New(ctx, p.request(params), p.requestOptions(params.Model)...)
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

func (p *Provider) requestOptions(model string) []option.RequestOption {
	if p.perModel == nil {
		return p.RequestOptions
	}
	extra := p.perModel(model)
	opts := make([]option.RequestOption, 0, len(p.RequestOptions)+len(extra))
	return append(append(opts, p.RequestOptions...), extra...)
}

// request converts scenario inference params to a chat completion request.
func (p *Provider) request(params scenario.InferenceParams) openai.ChatCompletionNewParams {
	req := openai.ChatCompletionNewParams{
		Model:    params.Model,
		Messages: ToOpenAIMessages(params.Messages),
	}
	if params.Temperature != nil {
		req.Temperature = openai.Float(*params.Temperature)
	}
	if params.MaxTokens != nil {
		if p.LegacyParams {
			req.MaxTokens = openai.Int(*params.MaxTokens)
		} else {
			req.MaxCompletionTokens = openai.Int(*params.MaxTokens)
		}
	}
	if len(params.Tools) > 0 {
		req.Tools = toOpenAITools(params.Tools)
	}
	if params.ToolChoice != nil {
		req.ToolChoice = toOpenAIToolChoice(params.ToolChoice)
	}
	return req
}
