// Package gemini adapts the Google GenAI generateContent API to scenario.LLM.
package gemini

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// Provider implements scenario.LLM with the Google GenAI Go SDK.
type Provider struct {
	Client *genai.Client
}

// NewProvider wraps a GenAI client.
func NewProvider(client *genai.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls generateContent.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	system, rest := splitSystem(params.Messages)
	cfg := &genai.GenerateContentConfig{SystemInstruction: system}
	if params.Temperature != nil {
		cfg.Temperature = genai.Ptr(float32(*params.Temperature))
	}
	if params.MaxTokens != nil {
		cfg.MaxOutputTokens = int32(*params.MaxTokens)
	}
	if len(params.Tools) > 0 {
		cfg.Tools = toGeminiTools(params.Tools)
	}
	if params.ToolChoice != nil {
		cfg.ToolConfig = toGeminiToolConfig(params.ToolChoice)
	}
	resp, err := p.Client.Models.GenerateContent(ctx, params.Model, ToGeminiContents(rest), cfg)
	if err != nil {
		return nil, err
	}
	if resp == nil || len(resp.Candidates) == 0 {
		return nil, errors.New("no response candidates from Gemini")
	}
	res := &scenario.InferenceResult{Message: fromGeminiCandidate(resp.Candidates[0])}
	if u := resp.UsageMetadata; u != nil {
		res.Usage = &scenario.Usage{InputTokens: int64(u.PromptTokenCount), OutputTokens: int64(u.CandidatesTokenCount)}
	}
	return res, nil
}
