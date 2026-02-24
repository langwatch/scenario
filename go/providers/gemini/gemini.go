package gemini

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// Provider implements scenario.Inference using the Google GenAI Go SDK.
type Provider struct {
	Client *genai.Client
}

// NewProvider creates a new Gemini provider wrapping the given client.
func NewProvider(client *genai.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the Gemini generateContent API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	systemInstruction, contents := extractSystemMessages(params.Messages)

	config := &genai.GenerateContentConfig{}

	if systemInstruction != nil {
		config.SystemInstruction = systemInstruction
	}

	if params.Temperature != nil {
		temp := float32(*params.Temperature)
		config.Temperature = &temp
	}
	if params.MaxTokens != nil {
		maxTokens := int32(*params.MaxTokens)
		config.MaxOutputTokens = &maxTokens
	}

	if len(params.Tools) > 0 {
		config.Tools = toGeminiTools(params.Tools)
	}
	if params.ToolChoice != nil {
		config.ToolConfig = toGeminiToolConfig(params.ToolChoice)
	}

	response, err := p.Client.Models.GenerateContent(ctx, params.Model, toGeminiContents(contents), config)
	if err != nil {
		return nil, err
	}

	if response == nil || len(response.Candidates) == 0 {
		return nil, errors.New("no response candidates from Gemini")
	}

	msg := fromGeminiResponse(response.Candidates[0])

	return &scenario.InferenceResult{
		Message: msg,
	}, nil
}
