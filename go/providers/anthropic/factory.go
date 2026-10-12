package anthropic

import (
	"errors"
	"os"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	scenario "github.com/langwatch/scenario/go"
)

// Register installs Factory as "anthropic", so model strings such as
// "anthropic/claude-sonnet-4-5" resolve. No client is built until a model
// is used.
func Register() { scenario.RegisterProvider("anthropic", Factory) }

// Factory is the scenario.ProviderFactory of this module, for
// scenario.RegisterProvider("anthropic", anthropic.Factory). Empty options
// fall back to ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) and
// ANTHROPIC_BASE_URL.
func Factory(opts scenario.ProviderOptions) (scenario.LLM, error) {
	p, err := New(opts)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// New builds a provider from registry options; see Factory.
func New(opts scenario.ProviderOptions) (*Provider, error) {
	if opts.APIKey == "" && os.Getenv("ANTHROPIC_API_KEY") == "" && os.Getenv("ANTHROPIC_AUTH_TOKEN") == "" {
		return nil, errors.New("anthropic: ANTHROPIC_API_KEY is not set")
	}
	var reqOpts []option.RequestOption
	if opts.APIKey != "" {
		reqOpts = append(reqOpts, option.WithAPIKey(opts.APIKey))
	}
	if opts.BaseURL != "" {
		reqOpts = append(reqOpts, option.WithBaseURL(opts.BaseURL))
	}
	for k, v := range opts.Headers {
		reqOpts = append(reqOpts, option.WithHeader(k, v))
	}
	client := anthropic.NewClient(reqOpts...)
	return NewProvider(&client), nil
}
