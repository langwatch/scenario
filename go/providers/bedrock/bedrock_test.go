package bedrock

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

func TestInferenceRequestAndResponse(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"output":{"message":{"role":"assistant","content":[{"text":"ok"},{"toolUse":{"toolUseId":"t1","name":"finish_test","input":{"a":1}}}]}},"stopReason":"tool_use","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3},"metrics":{"latencyMs":1}}`)
	}))
	defer srv.Close()
	client := bedrockruntime.New(bedrockruntime.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "a", SecretAccessKey: "b"}, nil
		}),
	})
	res, err := NewProvider(client).Inference(context.Background(), scenario.InferenceParams{
		Model: "model",
		Messages: []scenario.Message{
			scenario.SystemMsg("sys"),
			scenario.UserMsg("hi"),
			{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "a", Name: "f", Arguments: `{}`}}},
			scenario.ToolMsg("a", "one"),
			scenario.UserMsg("next"),
		},
		Tools: []scenario.ToolDefinition{{Name: "finish_test", Parameters: map[string]any{
			"type": "object", "properties": map[string]any{"criteria": json.RawMessage(`{"type":"object"}`)},
		}}},
		ToolChoice: scenario.RequireTool("finish_test"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Content != "ok" || res.Message.ToolCalls[0].Arguments != `{"a":1}` || res.Usage.OutputTokens != 2 {
		t.Fatalf("%+v", res)
	}
	if strings.Count(body, `"role":"user"`) != 2 || !strings.Contains(body, `"criteria":{"type":"object"}`) {
		t.Errorf("request:\n%s", body)
	}
}

func TestFailedToolResultsHaveErrorStatus(t *testing.T) {
	failed := scenario.ToolMsg("a", "boom")
	failed.IsError = true
	msgs := ToBedrockMessages([]scenario.Message{failed, scenario.ToolMsg("b", "fine")})
	var statuses []types.ToolResultStatus
	for _, b := range msgs[0].Content {
		statuses = append(statuses, b.(*types.ContentBlockMemberToolResult).Value.Status)
	}
	if len(statuses) != 2 || statuses[0] != types.ToolResultStatusError || statuses[1] != "" {
		t.Fatalf("statuses = %v", statuses)
	}
}
