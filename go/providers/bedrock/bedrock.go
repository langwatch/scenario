// Package bedrock adapts the AWS Bedrock Converse API to scenario.LLM.
package bedrock

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

// Provider implements scenario.LLM with the Bedrock Converse API.
type Provider struct {
	Client *bedrockruntime.Client
}

// NewProvider wraps a Bedrock runtime client.
func NewProvider(client *bedrockruntime.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls Converse.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	req, err := toRequest(params)
	if err != nil {
		return nil, err
	}
	out, err := p.Client.Converse(ctx, &bedrockruntime.ConverseInput{
		ModelId: req.ModelId, Messages: req.Messages, System: req.System,
		InferenceConfig: req.InferenceConfig, ToolConfig: req.ToolConfig,
	})
	if err != nil {
		return nil, err
	}
	if out == nil || out.Output == nil {
		return nil, errors.New("nil response from Bedrock")
	}
	msg, ok := out.Output.(*types.ConverseOutputMemberMessage)
	if !ok {
		return nil, errors.New("unexpected response type from Bedrock")
	}
	return &scenario.InferenceResult{Message: fromBedrockMessage(msg.Value), Usage: usageOf(out.Usage)}, nil
}

// toRequest converts scenario inference params to a Converse request, in
// its streaming form; Converse and ConverseStream take the same fields.
func toRequest(params scenario.InferenceParams) (*bedrockruntime.ConverseStreamInput, error) {
	system, rest := splitSystem(params.Messages)
	req := &bedrockruntime.ConverseStreamInput{
		ModelId:         aws.String(params.Model),
		Messages:        ToBedrockMessages(rest),
		InferenceConfig: toInferenceConfig(params.Temperature, params.MaxTokens),
	}
	if len(system) > 0 {
		req.System = system
	}
	if len(params.Tools) > 0 {
		cfg, err := toToolConfig(params.Tools, params.ToolChoice)
		if err != nil {
			return nil, err
		}
		req.ToolConfig = cfg
	}
	return req, nil
}

func usageOf(u *types.TokenUsage) *scenario.Usage {
	if u == nil || u.InputTokens == nil || u.OutputTokens == nil {
		return nil
	}
	return &scenario.Usage{InputTokens: int64(*u.InputTokens), OutputTokens: int64(*u.OutputTokens)}
}
