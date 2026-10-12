package stt

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/apihttp"
)

// Ported from javascript/src/voice/__tests__/stt.test.ts; the vendor SDK
// mocks become httptest servers checking the wire request.

type capture struct {
	path, auth, model, contentType string
	wav                            []byte
}

// fakeServer answers transcription requests with texts in turn, recording
// each request.
func fakeServer(t *testing.T, modelField string, texts ...string) (*httptest.Server, *[]capture) {
	t.Helper()
	var calls []capture
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		wav, _ := io.ReadAll(f)
		auth := r.Header.Get("Authorization")
		if auth == "" {
			auth = r.Header.Get("xi-api-key")
		}
		calls = append(calls, capture{path: r.URL.Path, auth: auth, model: r.FormValue(modelField), contentType: hdr.Header.Get("Content-Type"), wav: wav})
		i := int(n.Add(1)) - 1
		text := ""
		if i < len(texts) {
			text = texts[i]
		}
		fmt.Fprintf(w, `{"text":%q}`, text)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestOpenAIDefaultsToGPT4oTranscribe(t *testing.T) {
	if NewOpenAI(OpenAIOptions{}).Model() != "gpt-4o-transcribe" {
		t.Error("wrong default model")
	}
}

func TestOpenAISendsWAVWithModelAndKey(t *testing.T) {
	srv, calls := fakeServer(t, "model", "hi")
	p := NewOpenAI(OpenAIOptions{APIKey: "sk-test", BaseURL: srv.URL + "/v1"})
	text, err := p.Transcribe(context.Background(), audio.SilentChunk(0.5))
	if err != nil || text != "hi" {
		t.Fatalf("text %q err %v", text, err)
	}
	c := (*calls)[0]
	if c.path != "/v1/audio/transcriptions" || c.auth != "Bearer sk-test" || c.model != "gpt-4o-transcribe" || c.contentType != "audio/wav" {
		t.Errorf("request %+v", c)
	}
	w, err := audio.ParseWAV(c.wav)
	if err != nil || w.Format != audio.Canonical || len(w.Data) != 24000 {
		t.Errorf("uploaded WAV %+v err %v", w.Format, err)
	}
}

func TestOpenAIReadsBaseURLFromEnvironment(t *testing.T) {
	srv, calls := fakeServer(t, "model", "env")
	t.Setenv("OPENAI_BASE_URL", srv.URL+"/v1/")
	t.Setenv("OPENAI_API_KEY", "sk-env")
	if _, err := NewOpenAI(OpenAIOptions{}).Transcribe(context.Background(), audio.SilentChunk(0.1)); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.path != "/v1/audio/transcriptions" || c.auth != "Bearer sk-env" {
		t.Errorf("request %+v", c)
	}
}

func TestOpenAISplitsAudioOverTheLimit(t *testing.T) {
	srv, calls := fakeServer(t, "model", "seg1", "seg2", "seg3")
	p := NewOpenAI(OpenAIOptions{BaseURL: srv.URL, TranscribeLimitSeconds: 1})
	text, err := p.Transcribe(context.Background(), audio.SilentChunk(2.5))
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 3 || text != "seg1 seg2 seg3" {
		t.Errorf("%d calls, text %q", len(*calls), text)
	}
	if last, _ := audio.ParseWAV((*calls)[2].wav); len(last.Data) != 24000 {
		t.Errorf("last part %d bytes, want 0.5 s", len(last.Data))
	}
}

func TestOpenAIUsesOneRequestUnderTheLimit(t *testing.T) {
	srv, calls := fakeServer(t, "model", "short")
	p := NewOpenAI(OpenAIOptions{BaseURL: srv.URL, TranscribeLimitSeconds: 2})
	if text, _ := p.Transcribe(context.Background(), audio.SilentChunk(1)); text != "short" || len(*calls) != 1 {
		t.Errorf("%d calls, text %q", len(*calls), text)
	}
}

func TestOpenAIDropsEmptyPartTranscripts(t *testing.T) {
	srv, _ := fakeServer(t, "model", "seg1", "", "seg3")
	p := NewOpenAI(OpenAIOptions{BaseURL: srv.URL, TranscribeLimitSeconds: 1})
	if text, _ := p.Transcribe(context.Background(), audio.SilentChunk(2.5)); text != "seg1 seg3" {
		t.Errorf("text %q", text)
	}
}

func TestErrorStatusIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"bad key"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := NewOpenAI(OpenAIOptions{BaseURL: srv.URL}).Transcribe(context.Background(), audio.SilentChunk(0.1))
	var se *apihttp.StatusError
	if !errors.As(err, &se) || se.StatusCode != 401 || !strings.Contains(err.Error(), "bad key") {
		t.Errorf("err = %v", err)
	}
}

func TestElevenLabsSendsScribeRequest(t *testing.T) {
	srv, calls := fakeServer(t, "model_id", "hola")
	p := NewElevenLabs(ElevenLabsOptions{APIKey: "xi", BaseURL: srv.URL + "/"})
	text, err := p.Transcribe(context.Background(), audio.SilentChunk(0.2))
	if err != nil || text != "hola" {
		t.Fatalf("text %q err %v", text, err)
	}
	if c := (*calls)[0]; c.path != "/v1/speech-to-text" || c.auth != "xi" || c.model != "scribe_v1" {
		t.Errorf("request %+v", c)
	}
}

func TestElevenLabsIgnoresConvAIBaseURLVariable(t *testing.T) {
	t.Setenv("ELEVENLABS_BASE_URL", "https://gateway.example.com")
	if p := NewElevenLabs(ElevenLabsOptions{}); p.baseURL != "https://api.elevenlabs.io" {
		t.Errorf("speech-to-text followed ELEVENLABS_BASE_URL to %q", p.baseURL)
	}
	p := NewElevenLabs(ElevenLabsOptions{BaseURL: "https://gw.example.com/v1"})
	if _, err := p.Transcribe(context.Background(), audio.SilentChunk(0.1)); err == nil || !strings.Contains(err.Error(), "/v1") {
		t.Errorf("err = %v", err)
	}
}

func TestProviderFuncSatisfiesProvider(t *testing.T) {
	var p Provider = ProviderFunc(func(_ context.Context, c audio.Chunk) (string, error) { return c.Transcript, nil })
	if text, _ := p.Transcribe(context.Background(), audio.Chunk{Transcript: "ok"}); text != "ok" {
		t.Errorf("text %q", text)
	}
}

func TestRegistryResolvesSpecs(t *testing.T) {
	if p, err := Resolve("openai/gpt-4o-transcribe"); err != nil || p.(*OpenAI).Model() != "gpt-4o-transcribe" {
		t.Errorf("openai: %v %v", p, err)
	}
	if p, _ := Resolve("OpenAI/whisper-1"); p.(*OpenAI).Model() != "whisper-1" {
		t.Error("model segment not honoured")
	}
	if p, _ := Resolve("openai"); p.(*OpenAI).Model() != OpenAIModel {
		t.Error("bare provider did not use the default model")
	}
	if p, err := Resolve("elevenlabs/scribe_v1"); err != nil {
		t.Errorf("elevenlabs: %v", err)
	} else if _, ok := p.(*ElevenLabs); !ok {
		t.Errorf("elevenlabs resolved to %T", p)
	}
	if _, err := Resolve("deepgram/nova-2"); err == nil || !strings.Contains(err.Error(), `unknown STT provider "deepgram"`) {
		t.Errorf("err = %v", err)
	}
}

func TestRegistryAcceptsCustomFactories(t *testing.T) {
	r := NewRegistry()
	custom := ProviderFunc(func(context.Context, audio.Chunk) (string, error) { return "custom", nil })
	r.Register("myvendor", func(string) Provider { return custom })
	p, err := r.Resolve("myvendor/anything")
	if err != nil {
		t.Fatal(err)
	}
	if text, _ := p.Transcribe(context.Background(), audio.Chunk{}); text != "custom" {
		t.Errorf("text %q", text)
	}
	if got := Default().Providers(); !strings.Contains(strings.Join(got, ","), "elevenlabs") || !strings.Contains(strings.Join(got, ","), "openai") {
		t.Errorf("default providers %v", got)
	}
}
