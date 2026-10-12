package openai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// recorder is a progress sink that records events as "kind:id:payload".
type recorder struct{ events []string }

func (r *recorder) TextDelta(d string)            { r.events = append(r.events, "text:"+d) }
func (r *recorder) ToolCallStart(id, name string) { r.events = append(r.events, "start:"+id+":"+name) }
func (r *recorder) ToolCallArgs(id, d string)     { r.events = append(r.events, "args:"+id+":"+d) }
func (r *recorder) ToolCallEnd(id string)         { r.events = append(r.events, "end:"+id) }

func sseServer(t *testing.T, chunks ...string) (*httptest.Server, *string) {
	t.Helper()
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", c)
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, &body
}

func chunk(delta string) string {
	return `{"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":` + delta + `,"finish_reason":null}]}`
}

func TestStreamForwardsTextAndToolCalls(t *testing.T) {
	srv, body := sseServer(t,
		chunk(`{"role":"assistant","content":"Hel"}`),
		chunk(`{"content":"lo"}`),
		chunk(`{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":""}}]}`),
		chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}`),
		chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]}`),
		chunk(`{"tool_calls":[{"index":1,"type":"function","function":{"name":"get_time","arguments":"{}"}}]}`),
		`{"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`,
	)
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	rec := &recorder{}
	res, err := NewProvider(&client).stream(context.Background(), scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"text:Hel", "text:lo",
		"start:call_a:get_weather", `args:call_a:{"city":`, `args:call_a:"Paris"}`,
		"end:call_a", "start:call_1:get_time", "args:call_1:{}", "end:call_1",
	}
	if strings.Join(rec.events, "|") != strings.Join(want, "|") {
		t.Fatalf("events\n got %q\nwant %q", rec.events, want)
	}
	m := res.Message
	if m.Text() != "Hello" || len(m.ToolCalls) != 2 {
		t.Fatalf("message %+v", m)
	}
	if m.ToolCalls[0].ID != "call_a" || m.ToolCalls[0].Arguments != `{"city":"Paris"}` || m.ToolCalls[1].ID != "call_1" {
		t.Fatalf("tool calls %+v", m.ToolCalls)
	}
	if res.Usage == nil || res.Usage.OutputTokens != 7 {
		t.Fatalf("usage %+v", res.Usage)
	}
	if !strings.Contains(*body, `"stream":true`) || !strings.Contains(*body, `"include_usage":true`) {
		t.Fatalf("request %s", *body)
	}
}

func TestStreamChatCompletionAcceptsNilStream(t *testing.T) {
	srv, _ := sseServer(t, chunk(`{"role":"assistant","content":"ok"}`))
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	completion, err := StreamChatCompletion(context.Background(), &client, openai.ChatCompletionNewParams{
		Model: "m", Messages: []openai.ChatCompletionMessageParamUnion{openai.UserMessage("hi")},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if completion.Choices[0].Message.Content != "ok" {
		t.Fatalf("completion %+v", completion)
	}
}

func TestStreamLegacyServersGetNoStreamOptions(t *testing.T) {
	srv, body := sseServer(t, chunk(`{"role":"assistant","content":"ok"}`))
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	p := NewProvider(&client)
	p.LegacyParams = true
	if _, err := p.Stream(context.Background(), scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}}, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(*body, "stream_options") {
		t.Fatalf("request %s", *body)
	}
}

// Some OpenAI-compatible servers change the chunk id mid-stream; the
// accumulator refuses such chunks, which must not truncate the answer.
func TestStreamAccumulatesChunksWithChangingIDs(t *testing.T) {
	srv, _ := sseServer(t,
		chunk(`{"role":"assistant","content":"Hel"}`),
		strings.Replace(chunk(`{"content":"lo"}`), `"id":"c"`, `"id":"other"`, 1),
		`{"id":"","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`,
	)
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	rec := &recorder{}
	res, err := NewProvider(&client).stream(context.Background(), scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Text() != "Hello" || res.Usage == nil || res.Usage.OutputTokens != 7 {
		t.Fatalf("result %+v usage %+v", res.Message, res.Usage)
	}
}

// Some servers send index -1 for a single tool call; the events and the
// final message must name it alike.
func TestStreamToolCallIndexMinusOne(t *testing.T) {
	srv, _ := sseServer(t,
		chunk(`{"tool_calls":[{"index":-1,"type":"function","function":{"name":"f","arguments":"{\"a\":"}}]}`),
		chunk(`{"tool_calls":[{"index":-1,"function":{"arguments":"1}"}}]}`),
	)
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	rec := &recorder{}
	res, err := NewProvider(&client).stream(context.Background(), scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"start:call_0:f", `args:call_0:{"a":`, "args:call_0:1}", "end:call_0"}
	if strings.Join(rec.events, "|") != strings.Join(want, "|") {
		t.Fatalf("events\n got %q\nwant %q", rec.events, want)
	}
	if tcs := res.Message.ToolCalls; len(tcs) != 1 || tcs[0].ID != "call_0" || tcs[0].Arguments != `{"a":1}` {
		t.Fatalf("tool calls %+v", tcs)
	}
}
