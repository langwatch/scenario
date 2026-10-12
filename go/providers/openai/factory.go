package openai

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// Register installs Factory under every name this module serves, so model
// strings such as "openai/gpt-4.1-mini", "azure/my-deployment",
// "openrouter/anthropic/claude-sonnet-4.5" or "ollama/llama3.2" resolve. It
// only fills the registry; no client is built until a model is used.
func Register() {
	for _, name := range ProviderNames() {
		scenario.RegisterProvider(name, Factory)
	}
}

// Factory is the scenario.ProviderFactory of this module, for
// scenario.RegisterProvider. It serves "openai", "azure" and the
// OpenAI-compatible endpoints of EndpointFor, chosen by opts.Provider.
func Factory(opts scenario.ProviderOptions) (scenario.LLM, error) {
	p, err := New(opts)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// CompatibleFactory returns a factory for an OpenAI-compatible server that
// this module does not know, for example
//
//	scenario.RegisterProvider("gateway", openai.CompatibleFactory(openai.Endpoint{
//		BaseURL: "https://gateway.internal/v1", APIKeyEnv: []string{"GATEWAY_API_KEY"},
//	}))
func CompatibleFactory(ep Endpoint) scenario.ProviderFactory {
	return func(opts scenario.ProviderOptions) (scenario.LLM, error) {
		p, err := NewCompatible(ep, opts)
		if err != nil {
			return nil, err
		}
		return p, nil
	}
}

// New builds the provider a registry name stands for: OpenAI ("openai" or
// an empty name), Azure OpenAI ("azure", "azure_openai") or a known
// OpenAI-compatible endpoint. Empty options fall back to the environment.
func New(opts scenario.ProviderOptions) (*Provider, error) {
	switch name := strings.ToLower(opts.Provider); name {
	case "", "openai":
		return newOpenAI(opts)
	case "azure", "azure_openai":
		return NewAzure(AzureConfig{Endpoint: opts.BaseURL, APIKey: opts.APIKey, Headers: opts.Headers})
	default:
		ep, ok := EndpointFor(name)
		if !ok {
			return nil, fmt.Errorf("openai: unknown OpenAI-compatible provider %q; use openai.CompatibleFactory for custom endpoints", opts.Provider)
		}
		return NewCompatible(ep, opts)
	}
}

// newOpenAI builds an OpenAI client the usual way, so OPENAI_API_KEY,
// OPENAI_BASE_URL, OPENAI_ORG_ID and OPENAI_PROJECT_ID apply.
func newOpenAI(opts scenario.ProviderOptions) (*Provider, error) {
	if opts.APIKey == "" && os.Getenv("OPENAI_API_KEY") == "" {
		return nil, errors.New("openai: OPENAI_API_KEY is not set")
	}
	var reqOpts []option.RequestOption
	if opts.APIKey != "" {
		reqOpts = append(reqOpts, option.WithAPIKey(opts.APIKey))
	}
	if opts.BaseURL != "" {
		reqOpts = append(reqOpts, option.WithBaseURL(opts.BaseURL))
	}
	reqOpts = appendHeaders(reqOpts, opts.Headers)
	client := openai.NewClient(reqOpts...)
	return NewProvider(&client), nil
}

// NewCompatible builds a provider for an OpenAI-compatible server. Options
// win over the endpoint's environment variables, which win over its
// defaults. The client ignores OPENAI_* variables, so an OpenAI key never
// reaches another server.
func NewCompatible(ep Endpoint, opts scenario.ProviderOptions) (*Provider, error) {
	base := opts.BaseURL
	if base == "" {
		if env := firstEnv(ep.BaseURLEnv...); env != "" {
			base = normalizeBaseURL(env, ep.PathSuffix)
		} else {
			base = ep.BaseURL
		}
	}
	if base == "" {
		return nil, fmt.Errorf("openai: provider %q has no base URL; set one of %s", opts.Provider, strings.Join(ep.BaseURLEnv, ", "))
	}
	key := opts.APIKey
	if key == "" {
		key = firstEnv(ep.APIKeyEnv...)
	}
	if key == "" && !ep.KeyOptional {
		return nil, fmt.Errorf("openai: provider %q needs an API key; set %s", opts.Provider, strings.Join(ep.APIKeyEnv, " or "))
	}
	reqOpts := []option.RequestOption{option.WithBaseURL(base)}
	if key != "" {
		reqOpts = append(reqOpts, option.WithAPIKey(key))
	}
	reqOpts = appendHeaders(reqOpts, ep.Headers)
	reqOpts = appendHeaders(reqOpts, opts.Headers)
	p := NewProvider(clientWithoutEnv(reqOpts...))
	p.LegacyParams = ep.LegacyParams
	return p, nil
}

// AzureConfig configures Azure OpenAI. Empty fields fall back to the
// environment variables of LiteLLM, Microsoft's SDKs and the AI SDK.
type AzureConfig struct {
	// Endpoint is the resource address, "https://<resource>.openai.azure.com".
	// Defaults to AZURE_API_BASE, AZURE_OPENAI_ENDPOINT, or
	// AZURE_RESOURCE_NAME expanded to that address. A query of
	// "?api-version=…" sets APIVersion.
	Endpoint string
	// APIKey defaults to AZURE_API_KEY or AZURE_OPENAI_API_KEY.
	APIKey string
	// APIVersion selects the API: empty, "v1", "latest" or "preview" use the
	// v1 API (/openai/v1, the model is the deployment name); a dated version
	// such as "2024-10-21" uses the deployments API
	// (/openai/deployments/<deployment>?api-version=…). Defaults to
	// AZURE_API_VERSION or OPENAI_API_VERSION.
	APIVersion string
	// Headers are sent with every request.
	Headers map[string]string
}

// NewAzure builds a provider for Azure OpenAI with key authentication. The
// model of each request is the deployment name, as in "azure/<deployment>".
// For Microsoft Entra ID, build a client with the openai-go azure package
// and wrap it with NewProvider.
func NewAzure(cfg AzureConfig) (*Provider, error) {
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = firstEnv("AZURE_API_BASE", "AZURE_OPENAI_ENDPOINT")
	}
	if endpoint == "" {
		if name := firstEnv("AZURE_RESOURCE_NAME"); name != "" {
			endpoint = "https://" + name + ".openai.azure.com"
		}
	}
	if endpoint == "" {
		return nil, errors.New("openai: Azure needs an endpoint; set AZURE_API_BASE, AZURE_OPENAI_ENDPOINT or AZURE_RESOURCE_NAME")
	}
	u, err := url.Parse(normalizeBaseURL(endpoint, ""))
	if err != nil {
		return nil, fmt.Errorf("openai: Azure endpoint: %w", err)
	}
	version := cfg.APIVersion
	if v := u.Query().Get("api-version"); version == "" && v != "" {
		version = v
	}
	if version == "" {
		version = firstEnv("AZURE_API_VERSION", "OPENAI_API_VERSION")
	}
	u.RawQuery = ""
	key := cfg.APIKey
	if key == "" {
		key = firstEnv("AZURE_API_KEY", "AZURE_OPENAI_API_KEY")
	}
	if key == "" {
		return nil, errors.New("openai: Azure needs an API key; set AZURE_API_KEY or AZURE_OPENAI_API_KEY")
	}

	reqOpts := []option.RequestOption{option.WithHeader("api-key", key)}
	reqOpts = appendHeaders(reqOpts, cfg.Headers)
	var perModel func(string) []option.RequestOption
	switch strings.ToLower(version) {
	case "", "v1", "latest", "preview":
		base := strings.TrimRight(u.String(), "/")
		if !strings.Contains(u.Path, "/openai") {
			base += "/openai/v1"
		}
		reqOpts = append(reqOpts, option.WithBaseURL(base))
		if strings.EqualFold(version, "preview") {
			reqOpts = append(reqOpts, option.WithQuery("api-version", "preview"))
		}
	default:
		root := u.Scheme + "://" + u.Host
		reqOpts = append(reqOpts, option.WithBaseURL(root), option.WithQuery("api-version", version))
		perModel = func(deployment string) []option.RequestOption {
			return []option.RequestOption{option.WithBaseURL(root + "/openai/deployments/" + url.PathEscape(deployment))}
		}
	}
	p := NewProvider(clientWithoutEnv(reqOpts...))
	p.perModel = perModel
	return p, nil
}

// clientWithoutEnv builds a client that reads no OPENAI_* variables. Only
// the Chat service, the one Provider uses, is set.
func clientWithoutEnv(opts ...option.RequestOption) *openai.Client {
	opts = append([]option.RequestOption{option.WithHTTPClient(http.DefaultClient)}, opts...)
	return &openai.Client{Options: opts, Chat: openai.NewChatService(opts...)}
}

func appendHeaders(opts []option.RequestOption, headers map[string]string) []option.RequestOption {
	for k, v := range headers {
		opts = append(opts, option.WithHeader(k, v))
	}
	return opts
}
