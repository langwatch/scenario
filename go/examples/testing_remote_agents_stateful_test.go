// Example: Testing Remote Agents, Stateful with Thread ID
//
// The server keeps the conversation history per thread, so the adapter sends
// only the latest message plus the scenario's thread id.
//
// Mirrors: javascript/examples/vitest/tests/testing-remote-agents-stateful.test.ts
package examples

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// newTravelServer serves POST /chat: a travel assistant that remembers each
// thread's history server-side.
func newTravelServer(t *testing.T) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	conversations := map[string][]scenario.Message{}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		history := append(conversations[req.ThreadID], scenario.UserMsg(req.Message))
		mu.Unlock()

		res, err := newLLM().Inference(r.Context(), scenario.InferenceParams{
			Model: "gpt-4.1-mini",
			Messages: append([]scenario.Message{
				scenario.SystemMsg("You are a helpful travel assistant. Help users plan their trips and provide information about destinations."),
			}, history...),
		})
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		mu.Lock()
		conversations[req.ThreadID] = append(history, scenario.AssistantMsg(res.Message.Content))
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(chatResponse{Response: res.Message.Content})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentStateful(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	srv := newTravelServer(t)

	// Only the new message travels; the server finds the history by thread id.
	statefulAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		var res chatResponse
		req := chatRequest{Message: lastText(input.Messages), ThreadID: input.ThreadID}
		if err := postJSON(ctx, srv.URL+"/chat", nil, req, &res); err != nil {
			return nil, err
		}
		return scenario.TextReturn(res.Response), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Multi-turn travel planning",
		Description: "User asks about Paris, then asks a follow-up question that requires context from the previous answer",
		Agents: []scenario.AgentAdapter{
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			statefulAgent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Tell me about visiting Paris"),
			scenario.Agent(),
			scenario.User("How long should I stay there?"), // needs the earlier context
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"Agent should provide helpful travel information about Paris",
				"Agent should answer follow-up questions with context from previous conversation",
				"Agent should maintain conversational continuity",
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
