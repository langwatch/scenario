package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"

	"github.com/langwatch/scenario/go/voice/internal/apihttp"
)

// OpenAI defaults.
const (
	// OpenAIModel is the speech model. Swap the whole backend rather than
	// parameterising it, as in the JavaScript SDK.
	OpenAIModel = "gpt-4o-mini-tts"
	// OpenAIDefaultBaseURL is used when neither the options nor
	// OPENAI_BASE_URL name one.
	OpenAIDefaultBaseURL = "https://api.openai.com/v1"
)

// OpenAIOptions configure an [OpenAI] backend.
type OpenAIOptions struct {
	// APIKey defaults to OPENAI_API_KEY (read at each request, so a key set
	// after start-up is honoured).
	APIKey string
	// BaseURL defaults to OPENAI_BASE_URL, then [OpenAIDefaultBaseURL]; it
	// includes the /v1 prefix.
	BaseURL string
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
}

// OpenAI synthesizes with OpenAI's speech endpoint, asking for raw PCM16
// at 24 kHz mono (the canonical format).
type OpenAI struct{ o OpenAIOptions }

// NewOpenAI returns an OpenAI backend.
func NewOpenAI(o OpenAIOptions) *OpenAI { return &OpenAI{o: o} }

// Synthesize implements [SynthFunc].
func (p *OpenAI) Synthesize(ctx context.Context, text, voice string) ([]byte, error) {
	body, err := json.Marshal(map[string]string{
		"model": OpenAIModel, "voice": voice, "input": text, "response_format": "pcm",
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apihttp.JoinURL(p.baseURL(), "audio/speech"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+firstNonEmpty(p.o.APIKey, os.Getenv("OPENAI_API_KEY")))
	return apihttp.Do(p.o.HTTPClient, req, "OpenAI speech")
}

func (p *OpenAI) baseURL() string {
	return firstNonEmpty(p.o.BaseURL, os.Getenv("OPENAI_BASE_URL"), OpenAIDefaultBaseURL)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
