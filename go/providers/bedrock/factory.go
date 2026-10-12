package bedrock

import (
	"context"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/smithy-go/auth/bearer"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	scenario "github.com/langwatch/scenario/go"
)

// Register installs Factory as "bedrock", so model strings such as
// "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0" or
// "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0" resolve. No client
// is built until a model is used.
func Register() { scenario.RegisterProvider("bedrock", Factory) }

// Factory is the scenario.ProviderFactory of this module, for
// scenario.RegisterProvider("bedrock", bedrock.Factory). Credentials and
// region come from the AWS default chain (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_PROFILE, AWS_REGION, SSO,
// instance roles, …), with LiteLLM's AWS_REGION_NAME as a region fallback.
// APIKey, or AWS_BEARER_TOKEN_BEDROCK, is a Bedrock API key; BaseURL
// overrides the endpoint.
func Factory(opts scenario.ProviderOptions) (scenario.LLM, error) {
	p, err := New(opts)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// New builds a provider from registry options; see Factory.
func New(opts scenario.ProviderOptions) (*Provider, error) {
	var load []func(*config.LoadOptions) error
	if os.Getenv("AWS_REGION") == "" && os.Getenv("AWS_DEFAULT_REGION") == "" {
		if region := os.Getenv("AWS_REGION_NAME"); region != "" {
			load = append(load, config.WithRegion(region))
		}
	}
	cfg, err := config.LoadDefaultConfig(context.Background(), load...)
	if err != nil {
		return nil, err
	}
	client := bedrockruntime.NewFromConfig(cfg, func(o *bedrockruntime.Options) {
		if opts.BaseURL != "" {
			o.BaseEndpoint = aws.String(opts.BaseURL)
		}
		if key := opts.APIKey; key != "" {
			o.BearerAuthTokenProvider = bearer.TokenProviderFunc(func(context.Context) (bearer.Token, error) {
				return bearer.Token{Value: key}, nil
			})
			o.AuthSchemePreference = []string{"httpBearerAuth"}
		}
		for k, v := range opts.Headers {
			o.APIOptions = append(o.APIOptions, smithyhttp.SetHeaderValue(k, v))
		}
	})
	return NewProvider(client), nil
}
