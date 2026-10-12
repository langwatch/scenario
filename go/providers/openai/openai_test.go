package openai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

func TestInferenceRequestAndResponse(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"x","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"finish_test","arguments":"{\"a\":1}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`)
	}))
	defer srv.Close()
	client := openai.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("k"))
	temp := 0.0
	res, err := NewProvider(&client).Inference(context.Background(), scenario.InferenceParams{
		Model:       "gpt-test",
		Temperature: &temp,
		Messages: []scenario.Message{
			scenario.SystemMsg("sys"),
			{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.TextPart("listen"), scenario.AudioPart(scenario.MediaTypePCM16, []byte{1, 2})}},
			{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "c0", Name: "f", Arguments: "{}"}}},
			scenario.ToolMsg("c0", "ok"),
		},
		Tools: []scenario.ToolDefinition{{
			Name: "finish_test", Description: "d",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{"criteria": json.RawMessage(`{"type":"object","properties":{"zeta":{},"alpha":{}}}`)}},
		}},
		ToolChoice: scenario.RequireTool("finish_test"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].Name != "finish_test" || res.Usage.OutputTokens != 4 {
		t.Fatalf("response %+v", res)
	}
	for _, want := range []string{
		`"properties":{"zeta":{},"alpha":{}}`, // criteria keep their declared order
		`"type":"input_audio"`, `"format":"wav"`,
		`"tool_choice":{"function":{"name":"finish_test"},"type":"function"}`,
		`"temperature":0`,
		`"tool_call_id":"c0"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %s:\n%s", want, body)
		}
	}
}
