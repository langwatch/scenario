package gemini

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// Register installs Factory as "gemini" and "google" (the Gemini API, as in
// LiteLLM's and the AI SDK's model strings) and "vertex_ai" (Vertex AI), so
// "gemini/gemini-2.5-flash" or "vertex_ai/gemini-2.5-pro" resolve. No client
// is built until a model is used.
func Register() {
	for _, name := range []string{"gemini", "google", "vertex_ai"} {
		scenario.RegisterProvider(name, Factory)
	}
}

// Factory is the scenario.ProviderFactory of this module, for
// scenario.RegisterProvider. "vertex_ai" selects Vertex AI with Application
// Default Credentials, GOOGLE_CLOUD_PROJECT (or VERTEXAI_PROJECT) and
// GOOGLE_CLOUD_LOCATION (or VERTEXAI_LOCATION); other names select the
// Gemini API with GEMINI_API_KEY or GOOGLE_API_KEY.
func Factory(opts scenario.ProviderOptions) (scenario.LLM, error) {
	p, err := New(opts)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// New builds a provider from registry options; see Factory.
func New(opts scenario.ProviderOptions) (*Provider, error) {
	cc := &genai.ClientConfig{APIKey: opts.APIKey, Backend: genai.BackendGeminiAPI}
	if strings.EqualFold(opts.Provider, "vertex_ai") {
		cc.Backend = genai.BackendVertexAI
		cc.Project = firstEnv("GOOGLE_CLOUD_PROJECT", "VERTEXAI_PROJECT")
		cc.Location = firstEnv("GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_REGION", "VERTEXAI_LOCATION")
	} else if cc.APIKey == "" {
		cc.APIKey = firstEnv("GEMINI_API_KEY", "GOOGLE_API_KEY")
		if cc.APIKey == "" {
			return nil, errors.New("gemini: GEMINI_API_KEY (or GOOGLE_API_KEY) is not set")
		}
	}
	cc.HTTPOptions.BaseURL = opts.BaseURL
	if len(opts.Headers) > 0 {
		cc.HTTPOptions.Headers = http.Header{}
		for k, v := range opts.Headers {
			cc.HTTPOptions.Headers.Set(k, v)
		}
	}
	client, err := genai.NewClient(context.Background(), cc)
	if err != nil {
		return nil, err
	}
	return NewProvider(client), nil
}

func firstEnv(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}
