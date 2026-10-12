// Example: Testing Remote Agents, JSON Response
//
// The agent under test runs behind an HTTP endpoint; the adapter POSTs the
// latest user message and returns the "response" field of the JSON answer.
//
// Mirrors: javascript/examples/vitest/tests/testing-remote-agents-json.test.ts
package examples

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// chatRequest and chatResponse are the JSON bodies of the /chat endpoints.
type chatRequest struct {
	Message  string        `json:"message,omitempty"`
	ThreadID string        `json:"threadId,omitempty"`
	Messages []wireMessage `json:"messages,omitempty"`
}

type chatResponse struct {
	Response string `json:"response"`
}

// newWeatherServer serves POST /chat: a weather assistant answering one message.
func newWeatherServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		res, err := newLLM().Inference(r.Context(), scenario.InferenceParams{
			Model: "gpt-4.1-mini",
			Messages: []scenario.Message{
				// Pretending to have a weather API keeps the answers specific.
				scenario.SystemMsg("You are a helpful weather assistant. Provide brief, friendly responses about weather. Pretend like you have access to a weather API and make up the weather."),
				scenario.UserMsg(req.Message),
			},
		})
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(chatResponse{Response: res.Message.Content})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentJSON(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	srv := newWeatherServer(t)

	// The adapter sends the latest message (its text, for multipart content)
	// and returns the answer's "response" field; adjust both to your API.
	jsonAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		var res chatResponse
		if err := postJSON(ctx, srv.URL+"/chat", nil, chatRequest{Message: lastText(input.Messages)}, &res); err != nil {
			return nil, err
		}
		return scenario.TextReturn(res.Response), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Weather inquiry via HTTP",
		Description: "User asks about weather through HTTP API",
		Agents: []scenario.AgentAdapter{
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			jsonAgent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather like today in Paris? Be specific."),
			scenario.Agent(),
			scenario.User(),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"Agent should respond helpfully to weather questions",
				"Agent should provide specific weather information",
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
