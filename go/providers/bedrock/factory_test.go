package bedrock

import (
	"context"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestFactoryUsesEnvCredentialsAndOptions(t *testing.T) {
	var auth, extra, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		auth, extra, path = r.Header.Get("Authorization"), r.Header.Get("X-Extra"), r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"output":{"message":{"role":"assistant","content":[{"text":"ok"}]}},"stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3},"metrics":{"latencyMs":1}}`)
	}))
	defer srv.Close()
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_DEFAULT_REGION", "")
	t.Setenv("AWS_REGION_NAME", "eu-west-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIDTEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_PROFILE", "")
	t.Setenv("AWS_CONFIG_FILE", "/nonexistent")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent")
	t.Setenv("AWS_BEARER_TOKEN_BEDROCK", "")
	Register()
	t.Cleanup(func() { scenario.RegisterProvider("bedrock", nil) })
	cfg, err := scenario.ModelConfig{Model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0", BaseURL: srv.URL, Headers: map[string]string{"X-Extra": "1"}}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	res, err := cfg.LLM.Inference(context.Background(), scenario.InferenceParams{Model: cfg.Model, Messages: []scenario.Message{scenario.UserMsg("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Text() != "ok" || extra != "1" {
		t.Fatalf("message %q extra %q", res.Message.Text(), extra)
	}
	if !strings.Contains(auth, "Credential=AKIDTEST/") || !strings.Contains(auth, "/eu-west-1/bedrock/") {
		t.Fatalf("authorization %q", auth)
	}
	if !strings.HasPrefix(path, "/model/anthropic.claude-3-haiku-20240307-v1:0/converse") {
		t.Fatalf("path %s", path)
	}
}

func TestFactoryAPIKeyIsBearerToken(t *testing.T) {
	var auth string
	// The SDK refuses to send a bearer token over plain HTTP, so the fake
	// endpoint is HTTPS and the default config trusts it via AWS_CA_BUNDLE.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"output":{"message":{"role":"assistant","content":[{"text":"ok"}]}},"stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3},"metrics":{"latencyMs":1}}`)
	}))
	defer srv.Close()
	bundle := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_CA_BUNDLE", bundle)
	t.Setenv("AWS_REGION", "us-east-1")
	p, err := New(scenario.ProviderOptions{Provider: "bedrock", APIKey: "bedrock-key", BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Inference(context.Background(), scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}}); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer bedrock-key" {
		t.Fatalf("authorization %q", auth)
	}
}
