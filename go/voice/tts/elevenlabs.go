package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/langwatch/scenario/go/voice/internal/apihttp"
	"github.com/langwatch/scenario/go/voice/internal/elevenlabs"
)

// ElevenLabs defaults.
const (
	// ElevenLabsModel is the only ElevenLabs model that honours inline
	// paralinguistic markers such as [shouting] or [laughs].
	ElevenLabsModel = "eleven_v3"
	// ElevenLabsDefaultVoiceID is "Sarah", a premade voice available on the
	// free tier.
	ElevenLabsDefaultVoiceID = "EXAVITQu4vr4xnSDxMaL"
)

// ElevenLabsOptions configure an [ElevenLabs] backend.
type ElevenLabsOptions struct {
	// APIKey defaults to ELEVENLABS_API_KEY.
	APIKey string
	// BaseURL overrides https://api.elevenlabs.io (without /v1). It is
	// explicit only: ELEVENLABS_BASE_URL is deliberately not read, because a
	// LangWatch gateway fronts the ConvAI route and not text-to-speech.
	BaseURL string
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
}

// ElevenLabs synthesizes with the ElevenLabs text-to-speech endpoint in
// pcm_24000 output format (the canonical format).
type ElevenLabs struct{ o ElevenLabsOptions }

// NewElevenLabs returns an ElevenLabs backend.
func NewElevenLabs(o ElevenLabsOptions) *ElevenLabs { return &ElevenLabs{o: o} }

// Synthesize implements [SynthFunc]; voiceID is an ElevenLabs voice id.
func (p *ElevenLabs) Synthesize(ctx context.Context, text, voiceID string) ([]byte, error) {
	base, err := elevenlabs.LeafBaseURL(p.o.BaseURL)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]string{"text": text, "model_id": ElevenLabsModel})
	if err != nil {
		return nil, err
	}
	endpoint := apihttp.JoinURL(base, "v1/text-to-speech/"+url.PathEscape(voiceID)) + "?output_format=pcm_24000"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("xi-api-key", elevenlabs.LeafAPIKey(p.o.APIKey))
	return apihttp.Do(p.o.HTTPClient, req, "ElevenLabs text-to-speech")
}
