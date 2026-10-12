// Example: Testing Remote Agents, Streaming Response
//
// The remote agent streams its answer as plain text chunks; the adapter
// collects the whole stream into one message.
//
// Mirrors: javascript/examples/vitest/tests/testing-remote-agents-streaming.test.ts
package examples

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// newStreamingWeatherServer serves POST /chat/stream: the model's answer to
// the latest message, written and flushed chunk by chunk.
func newStreamingWeatherServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat/stream", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		flusher := w.(http.Flusher)
		err := streamChat(r.Context(),
			"You are a helpful weather assistant. Provide brief, friendly responses, immediately. Pretend like you have access to a weather API and make up the weather.",
			lastText(fromWire(req.Messages)),
			func(delta string) error {
				if _, err := io.WriteString(w, delta); err != nil {
					return err
				}
				flusher.Flush()
				return nil
			})
		if err != nil {
			t.Logf("streaming the answer: %v", err)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentStreaming(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	srv := newStreamingWeatherServer(t)

	// Read the chunked body to the end: the complete answer is the message.
	streamingAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		resp, err := post(ctx, srv.URL+"/chat/stream", nil, chatRequest{Messages: toWire(input.Messages)})
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		full, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return scenario.TextReturn(string(full)), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Streaming weather response",
		Description: "User asks about weather and receives streamed response",
		Agents: []scenario.AgentAdapter{
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			streamingAgent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather forecast in Amsterdam?"),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"Agent should provide weather information",
				"Response should be complete and coherent",
			)),
		},
		SetID: "go-examples",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
