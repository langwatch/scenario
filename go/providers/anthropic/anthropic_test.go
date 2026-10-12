package anthropic

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	scenario "github.com/langwatch/scenario/go"
)

func TestInferenceRequestAndResponse(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"m","type":"message","role":"assistant","model":"claude","stop_reason":"tool_use","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"t1","name":"finish_test","input":{"a":1}}],"usage":{"input_tokens":5,"output_tokens":6}}`)
	}))
	defer srv.Close()
	client := anthropic.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	res, err := NewProvider(&client).Inference(context.Background(), scenario.InferenceParams{
		Model: "claude",
		Messages: []scenario.Message{
			scenario.SystemMsg("sys"),
			scenario.UserMsg("hi"),
			{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "a", Name: "f", Arguments: `{"x":1}`}, {ID: "b", Name: "f", Arguments: `{}`}}},
			scenario.ToolMsg("a", "one"),
			scenario.ToolMsg("b", "two"),
			{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.AudioPart(scenario.MediaTypePCM16, []byte{1})}},
		},
		Tools:      []scenario.ToolDefinition{{Name: "f", Parameters: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}},
		ToolChoice: &scenario.ToolChoice{Type: scenario.ToolChoiceRequired},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Content != "ok" || res.Message.ToolCalls[0].Arguments != `{"a":1}` || res.Usage.OutputTokens != 6 {
		t.Fatalf("%+v", res.Message)
	}
	if strings.Count(body, `"role":"user"`) != 2 {
		t.Errorf("tool results and the next user turn must merge into one user message:\n%s", body)
	}
	for _, want := range []string{`"system":[{"text":"sys"`, `"additionalProperties":false`, `"tool_choice":{"type":"any"}`, `"text":"[audio message]"`} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %s:\n%s", want, body)
		}
	}
}
