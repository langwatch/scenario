package stt

import (
	"context"
	"net/http"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/apihttp"
	"github.com/langwatch/scenario/go/voice/internal/elevenlabs"
)

// ElevenLabsModel is the ElevenLabs (Scribe) transcription model.
const ElevenLabsModel = "scribe_v1"

// ElevenLabsOptions configure an [ElevenLabs] provider.
type ElevenLabsOptions struct {
	// APIKey defaults to ELEVENLABS_API_KEY.
	APIKey string
	// BaseURL overrides https://api.elevenlabs.io (without /v1). It is
	// explicit only: ELEVENLABS_BASE_URL is deliberately not read, because a
	// LangWatch gateway fronts the ConvAI route and not speech-to-text.
	BaseURL string
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
}

// ElevenLabs transcribes with the ElevenLabs speech-to-text endpoint.
type ElevenLabs struct {
	apiKey, baseURL string
	baseErr         error
	client          *http.Client
}

// NewElevenLabs returns an ElevenLabs provider. An invalid BaseURL is
// reported by the first Transcribe call.
func NewElevenLabs(o ElevenLabsOptions) *ElevenLabs {
	base, err := elevenlabs.LeafBaseURL(o.BaseURL)
	return &ElevenLabs{apiKey: elevenlabs.LeafAPIKey(o.APIKey), baseURL: base, baseErr: err, client: o.HTTPClient}
}

// String redacts the key.
func (p *ElevenLabs) String() string { return "ElevenLabsSTTProvider(apiKey='***')" }

// Transcribe returns the transcript of chunk.
func (p *ElevenLabs) Transcribe(ctx context.Context, chunk audio.Chunk) (string, error) {
	if p.baseErr != nil {
		return "", p.baseErr
	}
	body, contentType, err := wavUpload("file", chunk.Data, [2]string{"model_id", ElevenLabsModel})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apihttp.JoinURL(p.baseURL, "v1/speech-to-text"), body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("xi-api-key", p.apiKey)
	return postForText(p.client, req, "ElevenLabs speech-to-text")
}
