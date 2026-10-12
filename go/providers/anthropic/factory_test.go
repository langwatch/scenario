package anthropic

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestFactoryUsesOptionsAndRequiresKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	if _, err := Factory(scenario.ProviderOptions{Provider: "anthropic"}); err == nil {
		t.Fatal("missing ANTHROPIC_API_KEY should fail")
	}
	var key, extra string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		key, extra = r.Header.Get("X-Api-Key"), r.Header.Get("X-Extra")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"m","type":"message","role":"assistant","model":"claude","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer srv.Close()
	Register()
	t.Cleanup(func() { scenario.RegisterProvider("anthropic", nil) })
	cfg, err := scenario.ModelConfig{Model: "anthropic/claude-sonnet-4-5", APIKey: "sk-ant", BaseURL: srv.URL, Headers: map[string]string{"X-Extra": "1"}}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	res, err := cfg.LLM.Inference(context.Background(), scenario.InferenceParams{Model: cfg.Model, Messages: []scenario.Message{scenario.UserMsg("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Text() != "ok" || key != "sk-ant" || extra != "1" {
		t.Fatalf("message %q key %q extra %q", res.Message.Text(), key, extra)
	}
}
