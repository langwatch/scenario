package anthropic

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	scenario "github.com/langwatch/scenario/go"
)

// recorder is a progress sink that records events as "kind:id:payload".
type recorder struct{ events []string }

func (r *recorder) TextDelta(d string)            { r.events = append(r.events, "text:"+d) }
func (r *recorder) ToolCallStart(id, name string) { r.events = append(r.events, "start:"+id+":"+name) }
func (r *recorder) ToolCallArgs(id, d string)     { r.events = append(r.events, "args:"+id+":"+d) }
func (r *recorder) ToolCallEnd(id string)         { r.events = append(r.events, "end:"+id) }

func sseServer(t *testing.T, events ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range events {
			typ := e[strings.Index(e, `"type":"`)+8:]
			typ = typ[:strings.Index(typ, `"`)]
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", typ, e)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestStreamForwardsTextAndToolUse(t *testing.T) {
	srv := sseServer(t,
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"usage":{"input_tokens":4,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check."}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"Paris\"}"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}`,
		`{"type":"message_stop"}`,
	)
	client := anthropic.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	rec := &recorder{}
	res, err := NewProvider(&client).stream(context.Background(), scenario.InferenceParams{Model: "claude", Messages: []scenario.Message{scenario.UserMsg("hi")}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"text:Let me ", "text:check.", "start:toolu_1:get_weather", `args:toolu_1:{"city":`, `args:toolu_1:"Paris"}`, "end:toolu_1"}
	if strings.Join(rec.events, "|") != strings.Join(want, "|") {
		t.Fatalf("events\n got %q\nwant %q", rec.events, want)
	}
	if res.Message.Text() != "Let me check." || len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].Arguments != `{"city":"Paris"}` {
		t.Fatalf("message %+v", res.Message)
	}
	if res.Usage.InputTokens != 4 || res.Usage.OutputTokens != 9 {
		t.Fatalf("usage %+v", res.Usage)
	}
}

func TestStreamMessageAcceptsNilStream(t *testing.T) {
	srv := sseServer(t,
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_stop"}`,
	)
	client := anthropic.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	msg, err := StreamMessage(context.Background(), &client, anthropic.MessageNewParams{
		Model: "claude", MaxTokens: 10, Messages: []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("hi"))},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Content) != 1 || msg.Content[0].Text != "ok" {
		t.Fatalf("message %+v", msg)
	}
}
