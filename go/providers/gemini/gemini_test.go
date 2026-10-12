package gemini

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

func TestInferenceRequestAndResponse(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"},{"functionCall":{"name":"finish_test","args":{"a":1}}}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3}}`)
	}))
	defer srv.Close()
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{APIKey: "k", Backend: genai.BackendGeminiAPI, HTTPOptions: genai.HTTPOptions{BaseURL: srv.URL}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := NewProvider(client).Inference(context.Background(), scenario.InferenceParams{
		Model: "gemini-test",
		Messages: []scenario.Message{
			scenario.SystemMsg("sys"),
			{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.TextPart("hear"), scenario.AudioPart(scenario.MediaTypePCM16, []byte{1, 2})}},
			{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "c1", Name: "lookup", Arguments: `{"q":1}`}}},
			scenario.ToolMsg("c1", "sunny"),
		},
		Tools:      []scenario.ToolDefinition{{Name: "finish_test", Parameters: map[string]any{"type": "object", "additionalProperties": false}}},
		ToolChoice: scenario.RequireTool("finish_test"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Content != "ok" || res.Message.ToolCalls[0].Name != "finish_test" || res.Usage.InputTokens != 2 {
		t.Fatalf("%+v", res)
	}
	for _, want := range []string{`"mimeType":"audio/wav"`, `"functionResponse":{"id":"c1","name":"lookup","response":{"result":"sunny"}}`, `"parametersJsonSchema":{"additionalProperties":false,"type":"object"}`, `"allowedFunctionNames":["finish_test"]`} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %s:\n%s", want, body)
		}
	}
}

func TestFailedToolResultsAnswerUnderError(t *testing.T) {
	text := scenario.Message{Role: scenario.RoleTool, ToolCallID: "c1", ToolName: "f", Content: "boom", IsError: true}
	obj := scenario.Message{Role: scenario.RoleTool, ToolCallID: "c2", ToolName: "f", Content: `{"code":3}`, IsError: true}
	ok := scenario.Message{Role: scenario.RoleTool, ToolCallID: "c3", ToolName: "f", Content: "fine"}
	parts := ToGeminiContents([]scenario.Message{text, obj, ok})[0].Parts
	if got := parts[0].FunctionResponse.Response; !reflect.DeepEqual(got, map[string]any{"error": "boom"}) {
		t.Errorf("text error response = %v", got)
	}
	if got := parts[1].FunctionResponse.Response; !reflect.DeepEqual(got, map[string]any{"error": map[string]any{"code": float64(3)}}) {
		t.Errorf("json error response = %v", got)
	}
	if got := parts[2].FunctionResponse.Response; !reflect.DeepEqual(got, map[string]any{"result": "fine"}) {
		t.Errorf("success response = %v", got)
	}
}
