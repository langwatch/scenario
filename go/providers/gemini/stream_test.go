package gemini

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// recorder is a progress sink that records events as "kind:id:payload".
type recorder struct{ events []string }

func (r *recorder) TextDelta(d string)            { r.events = append(r.events, "text:"+d) }
func (r *recorder) ToolCallStart(id, name string) { r.events = append(r.events, "start:"+id+":"+name) }
func (r *recorder) ToolCallArgs(id, d string)     { r.events = append(r.events, "args:"+id+":"+d) }
func (r *recorder) ToolCallEnd(id string)         { r.events = append(r.events, "end:"+id) }

func sseClient(t *testing.T, chunks ...string) (*genai.Client, *string) {
	t.Helper()
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		path = r.URL.Path + "?" + r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\r\n\r\n", c)
		}
	}))
	t.Cleanup(srv.Close)
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{APIKey: "k", Backend: genai.BackendGeminiAPI, HTTPOptions: genai.HTTPOptions{BaseURL: srv.URL}})
	if err != nil {
		t.Fatal(err)
	}
	return client, &path
}

func TestStreamForwardsTextAndFunctionCalls(t *testing.T) {
	client, path := sseClient(t,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"Let me "}]}}]}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"check."}]}}]}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":8}}`,
	)
	rec := &recorder{}
	res, err := NewProvider(client).stream(context.Background(), scenario.InferenceParams{Model: "gemini-test", Messages: []scenario.Message{scenario.UserMsg("hi")}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"text:Let me ", "text:check.", "start:get_weather_1:get_weather", `args:get_weather_1:{"city":"Paris"}`, "end:get_weather_1"}
	if strings.Join(rec.events, "|") != strings.Join(want, "|") {
		t.Fatalf("events\n got %q\nwant %q", rec.events, want)
	}
	m := res.Message
	if m.Text() != "Let me check." || len(m.ToolCalls) != 1 || m.ToolCalls[0].ID != "get_weather_1" || m.ToolCalls[0].Arguments != `{"city":"Paris"}` {
		t.Fatalf("message %+v", m)
	}
	if res.Usage == nil || res.Usage.OutputTokens != 8 {
		t.Fatalf("usage %+v", res.Usage)
	}
	if !strings.Contains(*path, ":streamGenerateContent") {
		t.Fatalf("path %s", *path)
	}
}

func TestStreamGenerateContentAcceptsNilStream(t *testing.T) {
	client, _ := sseClient(t, `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}`)
	resp, err := StreamGenerateContent(context.Background(), client, "gemini-test", []*genai.Content{genai.NewContentFromText("hi", genai.RoleUser)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Candidates[0].Content.Parts[0].Text != "ok" {
		t.Fatalf("response %+v", resp)
	}
}

func TestFactoryRequiresKeyAndRegisters(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("GOOGLE_API_KEY", "")
	if _, err := Factory(scenario.ProviderOptions{Provider: "gemini"}); err == nil {
		t.Fatal("missing key should fail")
	}
	t.Setenv("GEMINI_API_KEY", "g")
	Register()
	t.Cleanup(func() {
		for _, n := range []string{"gemini", "google", "vertex_ai"} {
			scenario.RegisterProvider(n, nil)
		}
	})
	cfg, err := scenario.ModelConfig{Model: "google/gemini-2.5-flash"}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "gemini-2.5-flash" || cfg.LLM == nil {
		t.Fatalf("resolved %+v", cfg)
	}
}
