package openai

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

const completionJSON = `{"id":"x","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"hello"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`

// capture records the last request a test server received.
type capture struct {
	path, query, body string
	header            http.Header
}

func completionServer(t *testing.T) (*httptest.Server, *capture) {
	t.Helper()
	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.path, got.query, got.body, got.header = r.URL.Path, r.URL.RawQuery, string(b), r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, completionJSON)
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func ask(t *testing.T, llm scenario.LLM, model string) {
	t.Helper()
	limit := int64(50)
	res, err := llm.Inference(context.Background(), scenario.InferenceParams{Model: model, Messages: []scenario.Message{scenario.UserMsg("hi")}, MaxTokens: &limit})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Text() != "hello" {
		t.Fatalf("message %+v", res.Message)
	}
}

func TestCompatibleEndpointUsesItsOwnKeyAndAddress(t *testing.T) {
	srv, got := completionServer(t)
	t.Setenv("OPENAI_API_KEY", "openai-key-must-not-leak")
	t.Setenv("OPENAI_ORG_ID", "org-must-not-leak")
	t.Setenv("OPENROUTER_API_BASE", srv.URL+"/api/v1")
	t.Setenv("OPENROUTER_API_KEY", "or-key")
	llm, err := Factory(scenario.ProviderOptions{Provider: "openrouter", Headers: map[string]string{"HTTP-Referer": "https://example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, llm, "anthropic/claude-sonnet-4.5")
	if got.path != "/api/v1/chat/completions" {
		t.Errorf("path %s", got.path)
	}
	if a := got.header.Get("Authorization"); a != "Bearer or-key" {
		t.Errorf("authorization %q", a)
	}
	if got.header.Get("OpenAI-Organization") != "" {
		t.Error("OPENAI_ORG_ID leaked to another server")
	}
	if got.header.Get("HTTP-Referer") != "https://example.test" {
		t.Errorf("headers %v", got.header)
	}
	if !strings.Contains(got.body, `"model":"anthropic/claude-sonnet-4.5"`) || !strings.Contains(got.body, `"max_completion_tokens":50`) {
		t.Errorf("body %s", got.body)
	}
}

func TestOllamaNeedsNoKeyAndGetsV1Path(t *testing.T) {
	srv, got := completionServer(t)
	t.Setenv("OLLAMA_API_KEY", "")
	t.Setenv("OLLAMA_API_BASE", strings.TrimPrefix(srv.URL, "http://")) // OLLAMA_HOST style, no scheme
	llm, err := Factory(scenario.ProviderOptions{Provider: "ollama"})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, llm, "llama3.2")
	if got.path != "/v1/chat/completions" {
		t.Errorf("path %s", got.path)
	}
	if got.header.Get("Authorization") != "" {
		t.Errorf("no key should send no Authorization, got %q", got.header.Get("Authorization"))
	}
	if !strings.Contains(got.body, `"max_tokens":50`) || strings.Contains(got.body, "max_completion_tokens") {
		t.Errorf("legacy servers get max_tokens: %s", got.body)
	}
}

func TestCompatibleEndpointRequiresKey(t *testing.T) {
	t.Setenv("GROQ_API_KEY", "")
	if _, err := Factory(scenario.ProviderOptions{Provider: "groq"}); err == nil || !strings.Contains(err.Error(), "GROQ_API_KEY") {
		t.Fatalf("err %v", err)
	}
	if _, err := Factory(scenario.ProviderOptions{Provider: "groq", APIKey: "k"}); err != nil {
		t.Fatalf("explicit key: %v", err)
	}
}

func TestAliasesAndUnknownNames(t *testing.T) {
	for _, alias := range []string{"together", "vllm", "litellm", "fireworks"} {
		if _, ok := EndpointFor(alias); !ok {
			t.Errorf("alias %s unknown", alias)
		}
	}
	if _, err := New(scenario.ProviderOptions{Provider: "nope"}); err == nil {
		t.Fatal("unknown provider should fail")
	}
}

func TestOpenAIUsesExplicitOptions(t *testing.T) {
	srv, got := completionServer(t)
	t.Setenv("OPENAI_API_KEY", "")
	if _, err := Factory(scenario.ProviderOptions{Provider: "openai"}); err == nil {
		t.Fatal("missing OPENAI_API_KEY should fail")
	}
	llm, err := Factory(scenario.ProviderOptions{Provider: "openai", APIKey: "sk-test", BaseURL: srv.URL + "/v1"})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, llm, "gpt-4.1-mini")
	if got.path != "/v1/chat/completions" || got.header.Get("Authorization") != "Bearer sk-test" {
		t.Errorf("path %s auth %q", got.path, got.header.Get("Authorization"))
	}
}

func TestAzureV1API(t *testing.T) {
	srv, got := completionServer(t)
	t.Setenv("AZURE_API_VERSION", "")
	t.Setenv("OPENAI_API_VERSION", "")
	t.Setenv("AZURE_API_BASE", srv.URL)
	t.Setenv("AZURE_API_KEY", "az-key")
	llm, err := Factory(scenario.ProviderOptions{Provider: "azure"})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, llm, "my-deployment")
	if got.path != "/openai/v1/chat/completions" || got.query != "" {
		t.Errorf("path %s?%s", got.path, got.query)
	}
	if got.header.Get("api-key") != "az-key" || got.header.Get("Authorization") != "" {
		t.Errorf("headers %v", got.header)
	}
	if !strings.Contains(got.body, `"model":"my-deployment"`) {
		t.Errorf("body %s", got.body)
	}
}

func TestAzureDeploymentsAPI(t *testing.T) {
	srv, got := completionServer(t)
	p, err := NewAzure(AzureConfig{Endpoint: srv.URL + "?api-version=2024-10-21", APIKey: "az-key"})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, p, "dep-1")
	if got.path != "/openai/deployments/dep-1/chat/completions" || got.query != "api-version=2024-10-21" {
		t.Errorf("path %s?%s", got.path, got.query)
	}
}

func TestAzureRequiresEndpointAndKey(t *testing.T) {
	for _, env := range []string{"AZURE_API_BASE", "AZURE_OPENAI_ENDPOINT", "AZURE_RESOURCE_NAME", "AZURE_API_KEY", "AZURE_OPENAI_API_KEY"} {
		t.Setenv(env, "")
	}
	if _, err := NewAzure(AzureConfig{}); err == nil {
		t.Fatal("missing endpoint should fail")
	}
	t.Setenv("AZURE_RESOURCE_NAME", "res")
	if _, err := NewAzure(AzureConfig{}); err == nil || !strings.Contains(err.Error(), "AZURE_API_KEY") {
		t.Fatalf("missing key: %v", err)
	}
}

func TestRegisterResolvesModelStrings(t *testing.T) {
	srv, got := completionServer(t)
	Register()
	t.Cleanup(func() {
		for _, name := range ProviderNames() {
			scenario.RegisterProvider(name, nil)
		}
	})
	cfg, err := scenario.ModelConfig{Model: "groq/llama-3.3-70b-versatile", APIKey: "g", BaseURL: srv.URL}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	ask(t, cfg.LLM, cfg.Model)
	if !strings.Contains(got.body, `"model":"llama-3.3-70b-versatile"`) {
		t.Errorf("body %s", got.body)
	}
}
