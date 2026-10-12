package stt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/apihttp"
)

// OpenAI defaults.
const (
	// OpenAIModel is the default transcription model.
	OpenAIModel = "gpt-4o-transcribe"
	// OpenAITranscribeLimitSeconds is OpenAI's per-request audio limit
	// (25 minutes); longer audio is split.
	OpenAITranscribeLimitSeconds = 25 * 60
	// OpenAIDefaultBaseURL is used when neither the options nor
	// OPENAI_BASE_URL name one.
	OpenAIDefaultBaseURL = "https://api.openai.com/v1"
)

// OpenAIOptions configure an [OpenAI] provider. Zero values select the
// defaults.
type OpenAIOptions struct {
	// Model defaults to [OpenAIModel].
	Model string
	// APIKey defaults to OPENAI_API_KEY.
	APIKey string
	// BaseURL defaults to OPENAI_BASE_URL, then [OpenAIDefaultBaseURL].
	// Like the OpenAI SDKs, it includes the /v1 prefix.
	BaseURL string
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
	// TranscribeLimitSeconds overrides [OpenAITranscribeLimitSeconds].
	TranscribeLimitSeconds float64
}

// OpenAI transcribes with OpenAI's audio transcription endpoint.
type OpenAI struct {
	model, apiKey, baseURL string
	client                 *http.Client
	limitSeconds           float64
}

// NewOpenAI returns an OpenAI provider. Credentials are read from the
// environment at construction when not given.
func NewOpenAI(o OpenAIOptions) *OpenAI {
	p := &OpenAI{model: o.Model, apiKey: o.APIKey, baseURL: o.BaseURL, client: o.HTTPClient, limitSeconds: o.TranscribeLimitSeconds}
	if p.model == "" {
		p.model = OpenAIModel
	}
	if p.apiKey == "" {
		p.apiKey = os.Getenv("OPENAI_API_KEY")
	}
	if p.baseURL == "" {
		p.baseURL = os.Getenv("OPENAI_BASE_URL")
	}
	if p.baseURL == "" {
		p.baseURL = OpenAIDefaultBaseURL
	}
	if p.limitSeconds == 0 {
		p.limitSeconds = OpenAITranscribeLimitSeconds
	}
	return p
}

// Model is the transcription model in use.
func (p *OpenAI) Model() string { return p.model }

// String redacts the key.
func (p *OpenAI) String() string {
	return fmt.Sprintf("OpenAISTTProvider(model=%q, apiKey='***')", p.model)
}

// Transcribe returns the transcript of chunk. Audio over the per-request
// limit is split; parts are transcribed in order and joined with single
// spaces, skipping empty ones.
func (p *OpenAI) Transcribe(ctx context.Context, chunk audio.Chunk) (string, error) {
	if chunk.Seconds() <= p.limitSeconds {
		return p.transcribeOne(ctx, chunk.Data)
	}
	step := int(p.limitSeconds*audio.SampleRate) * audio.SampleWidth
	var parts []string
	for i := 0; i < len(chunk.Data); i += step {
		text, err := p.transcribeOne(ctx, chunk.Data[i:min(i+step, len(chunk.Data))])
		if err != nil {
			return "", err
		}
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " "), nil
}

func (p *OpenAI) transcribeOne(ctx context.Context, pcm []byte) (string, error) {
	body, contentType, err := wavUpload("file", pcm, [2]string{"model", p.model})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apihttp.JoinURL(p.baseURL, "audio/transcriptions"), body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	return postForText(p.client, req, "OpenAI transcription")
}

// postForText sends req and decodes a {"text": ...} response.
func postForText(client *http.Client, req *http.Request, op string) (string, error) {
	raw, err := apihttp.Do(client, req, op)
	if err != nil {
		return "", err
	}
	var resp struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("%s: decoding response: %w", op, err)
	}
	return resp.Text, nil
}
