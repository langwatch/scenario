// Package bedrock adapts the AWS Bedrock Converse API to scenario.LLM.
package bedrock

import (
	"context"
	"errors"

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
	system, rest := splitSystem(params.Messages)
	input := &bedrockruntime.ConverseInput{
		ModelId:         &params.Model,
		Messages:        ToBedrockMessages(rest),
		InferenceConfig: toInferenceConfig(params.Temperature, params.MaxTokens),
	}
	if len(system) > 0 {
		input.System = system
	}
	if len(params.Tools) > 0 {
		cfg, err := toToolConfig(params.Tools, params.ToolChoice)
		if err != nil {
			return nil, err
		}
		input.ToolConfig = cfg
	}
	out, err := p.Client.Converse(ctx, input)
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
	res := &scenario.InferenceResult{Message: fromBedrockMessage(msg.Value)}
	if u := out.Usage; u != nil && u.InputTokens != nil && u.OutputTokens != nil {
		res.Usage = &scenario.Usage{InputTokens: int64(*u.InputTokens), OutputTokens: int64(*u.OutputTokens)}
	}
	return res, nil
}
