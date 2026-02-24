package bedrock

import (
	"context"
	"errors"

	scenario "github.com/langwatch/scenario/go"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// Provider implements scenario.Inference using AWS Bedrock's Converse API.
type Provider struct {
	Client *bedrockruntime.Client
}

// NewProvider creates a new Bedrock provider wrapping the given client.
func NewProvider(client *bedrockruntime.Client) *Provider {
	return &Provider{Client: client}
}

// Inference calls the Bedrock Converse API.
func (p *Provider) Inference(ctx context.Context, params scenario.InferenceParams) (*scenario.InferenceResult, error) {
	system, messages := extractSystemMessages(params.Messages)

	input := &bedrockruntime.ConverseInput{
		ModelId:  &params.Model,
		Messages: toBedrockMessages(messages),
	}

	if len(system) > 0 {
		input.System = system
	}

	config := toBedrockInferenceConfig(params.Temperature, params.MaxTokens)
	if config != nil {
		input.InferenceConfig = config
	}

	if len(params.Tools) > 0 {
		input.ToolConfig = toBedrockToolConfig(params.Tools, params.ToolChoice)
	}

	output, err := p.Client.Converse(ctx, input)
	if err != nil {
		return nil, err
	}

	if output == nil || output.Output == nil {
		return nil, errors.New("nil response from Bedrock")
	}

	msgOutput, ok := output.Output.(*types.ConverseOutputMemberMessage)
	if !ok {
		return nil, errors.New("unexpected response type from Bedrock")
	}

	msg := fromBedrockMessage(msgOutput.Value)

	return &scenario.InferenceResult{
		Message: msg,
	}, nil
}
