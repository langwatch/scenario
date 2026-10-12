// Example: Testing Remote Agents, Server-Sent Events
//
// The remote agent streams in the SSE format OpenAI and similar APIs use:
// one "data: {json}" event per chunk, ending with "data: [DONE]". The adapter
// parses the events and joins their content.
//
// Mirrors: javascript/examples/vitest/tests/testing-remote-agents-sse.test.ts
package examples

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// sseChunk is the JSON payload of one SSE data event.
type sseChunk struct {
	Content string `json:"content"`
}

// newSSEWeatherServer serves POST /chat/sse: the model's answer to the
// latest message as a stream of SSE events.
func newSSEWeatherServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat/sse", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher := w.(http.Flusher)
		err := streamChat(r.Context(),
			"You are a helpful weather assistant. Provide brief, friendly responses. Pretend like you have access to a weather API and make up the weather.",
			lastText(fromWire(req.Messages)),
			func(delta string) error {
				data, err := json.Marshal(sseChunk{Content: delta})
				if err != nil {
					return err
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
					return err
				}
				flusher.Flush()
				return nil
			})
		if err != nil {
			t.Logf("streaming the answer: %v", err)
			return
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentSSE(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	srv := newSSEWeatherServer(t)

	sseAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		resp, err := post(ctx, srv.URL+"/chat/sse",
			map[string]string{"Accept": "text/event-stream"},
			chatRequest{Messages: toWire(input.Messages)})
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		var full strings.Builder
		lines := bufio.NewScanner(resp.Body)
		for lines.Scan() {
			data, ok := strings.CutPrefix(lines.Text(), "data: ")
			if !ok {
				continue // blank separator lines and other SSE fields
			}
			if data == "[DONE]" {
				break
			}
			var chunk sseChunk
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				continue // skip malformed events
			}
			full.WriteString(chunk.Content)
		}
		if err := lines.Err(); err != nil {
			return nil, err
		}
		return scenario.TextReturn(full.String()), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "SSE weather response",
		Description: "User asks about weather and receives SSE-formatted stream",
		Agents: []scenario.AgentAdapter{
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			sseAgent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather like in Tokyo today?"),
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
