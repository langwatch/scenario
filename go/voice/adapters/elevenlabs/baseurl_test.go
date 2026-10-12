package elevenlabs

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/langwatch/scenario/go/voice/tts"
)

// The base URL is checked at construction: the mistake people make (a /v1
// suffix copied from OPENAI_BASE_URL habits) otherwise surfaces as a 404
// from /v1/v1/convai/... that names no cause.

func TestBaseURLIsCheckedAtConstruction(t *testing.T) {
	t.Setenv("ELEVENLABS_BASE_URL", "")
	for raw, want := range map[string]string{
		"https://gateway.example/v1":  "/v1/v1",
		"https://gateway.example/v1/": "must not include /v1",
		"gateway.example":             "is not a URL",
		"ftp://gateway.example":       "must be http or https",
		"file:///tmp/gateway":         "is not a URL",
	} {
		_, err := New(Options{AgentID: "agent_test", APIKey: "key_test", BaseURL: raw})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err %v, want %q", raw, err, want)
		}
	}
	tr := must(New(Options{AgentID: "a", APIKey: "k", BaseURL: "https://gateway.example/"}))
	if tr.o.BaseURL != "https://gateway.example" {
		t.Fatalf("base %q", tr.o.BaseURL)
	}
	tr = must(New(Options{AgentID: "a", APIKey: "k", BaseURL: "   "}))
	if tr.o.BaseURL != "https://api.elevenlabs.io" {
		t.Fatalf("blank base %q, want the vendor default", tr.o.BaseURL)
	}
}

func TestBaseURLFromTheEnvironment(t *testing.T) {
	t.Setenv("ELEVENLABS_BASE_URL", "https://gateway.example/")
	if got := must(New(Options{AgentID: "a", APIKey: "k"})).o.BaseURL; got != "https://gateway.example" {
		t.Fatalf("env base %q", got)
	}
	t.Setenv("ELEVENLABS_BASE_URL", "https://from-env.example")
	if got := must(New(Options{AgentID: "a", APIKey: "k", BaseURL: "https://explicit.example"})).o.BaseURL; got != "https://explicit.example" {
		t.Fatalf("explicit base %q", got)
	}
}

func TestSignedURLIsMintedAtTheBaseURL(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	var paths []string
	var mu sync.Mutex
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		// A gateway mounted under /gw forwards to the fake's own route.
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(r.URL.Path, "/gw")
		return http.DefaultTransport.RoundTrip(r2)
	})}
	o := f.options("agt")
	o.BaseURL = f.srv.URL + "/gw/"
	o.HTTPClient = client
	o.Dialer = nil // the default dialer, over the injected client
	f.connect(o)
	if len(paths) == 0 || paths[0] != "/gw/v1/convai/conversation/get-signed-url" {
		t.Fatalf("requested %v", paths)
	}
}

func TestConvAIKeyPrecedence(t *testing.T) {
	f := newFake(t)
	key := func(explicit string) string {
		t.Helper()
		o := f.options("agt")
		o.APIKey = explicit
		tr := must(New(o))
		if err := tr.Connect(context.Background()); err != nil {
			t.Fatal(err)
		}
		_ = tr.Disconnect(context.Background())
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.lastAPIKey
	}
	t.Setenv("ELEVENLABS_CONVAI_API_KEY", "vk-lw-test")
	t.Setenv("ELEVENLABS_API_KEY", "sk_vendor")
	if got := key(""); got != "vk-lw-test" {
		t.Fatalf("got %q, want the ConvAI key", got)
	}
	if got := key("sk_explicit"); got != "sk_explicit" {
		t.Fatalf("got %q, want the explicit key", got)
	}
	t.Setenv("ELEVENLABS_CONVAI_API_KEY", "  ")
	if got := key(" "); got != "sk_vendor" {
		t.Fatalf("got %q, want the vendor key behind blank candidates", got)
	}
}

// ELEVENLABS_BASE_URL moves only the ConvAI mint: a LangWatch gateway has
// no route for speech-to-text or text-to-speech, so those stay on
// ElevenLabs unless given an explicit base URL.
func TestBaseURLEnvironmentScope(t *testing.T) {
	t.Setenv("ELEVENLABS_BASE_URL", "https://gateway.example")
	var hosts []string
	var mu sync.Mutex
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		hosts = append(hosts, r.URL.Host)
		mu.Unlock()
		body := `{"text":"hello"}`
		if strings.Contains(r.URL.Path, "text-to-speech") {
			body = "\x00\x00"
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}
	if got := must(New(Options{AgentID: "a", APIKey: "k"})).o.BaseURL; got != "https://gateway.example" {
		t.Fatalf("ConvAI base %q", got)
	}
	ctx := context.Background()
	if _, err := stt.NewElevenLabs(stt.ElevenLabsOptions{APIKey: "key", HTTPClient: client}).Transcribe(ctx, voice.AudioChunk{Data: make([]byte, 2)}); err != nil {
		t.Fatal(err)
	}
	if _, err := tts.NewElevenLabs(tts.ElevenLabsOptions{APIKey: "key", HTTPClient: client}).Synthesize(ctx, "hi", "voice_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := tts.NewElevenLabs(tts.ElevenLabsOptions{APIKey: "key", HTTPClient: client, BaseURL: "https://proxy.example"}).Synthesize(ctx, "hi", "voice_1"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(hosts, ",") != "api.elevenlabs.io,api.elevenlabs.io,proxy.example" {
		t.Fatalf("leaf hosts %v", hosts)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
