// Example: Testing Remote Agents, Judging on Remote Traces
//
// The remote agent answers with final text only, so its tool calls are not in
// the transcript. The adapter forwards input.PropagationHeaders so the
// server's spans join the turn's trace, and FetchRemoteTraces makes the judge
// check the tool call against those spans.
//
// Mirrors: javascript/examples/vitest/tests/testing-remote-agents-traces.test.ts
package examples

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel/propagation"
)

// orderTool is the order-system lookup the judge must find in the trace.
var orderTool = scenario.ToolDefinition{
	Name:        "lookup_order_status",
	Description: "Look up the current status of an order by its id",
	Parameters: map[string]any{
		"type": "object",
		"properties": map[string]any{
			"orderId": map[string]any{
				"type":        "string",
				"description": "The order id to look up",
			},
		},
		"required":             []string{"orderId"},
		"additionalProperties": false,
	},
	Strict: true,
}

// lookupOrderStatus simulates the order system inside a tool span.
func lookupOrderStatus(ctx context.Context, call scenario.ToolCall) string {
	_, span := langwatch.Tracer("order-service").Start(ctx, call.Name)
	defer span.End()
	span.SetType(langwatch.SpanTypeTool).SetInputText(call.Arguments)

	var args struct {
		OrderID string `json:"orderId"`
	}
	if err := json.Unmarshal([]byte(call.Arguments), &args); err != nil {
		span.SetOutputText("Error: " + err.Error())
		return "Error: " + err.Error()
	}
	out, _ := json.Marshal(map[string]string{"orderId": args.OrderID, "status": "shipped", "carrier": "DHL"})
	span.SetOutputJSON(json.RawMessage(out))
	return string(out)
}

// answerOrderQuestion runs the support agent: up to three model steps, the
// tool calls in between, and the final text as the answer.
func answerOrderQuestion(ctx context.Context, history []scenario.Message) (string, error) {
	msgs := append([]scenario.Message{
		scenario.SystemMsg("You are an order support assistant. Use the lookup_order_status tool to check orders before answering."),
	}, history...)
	var last string
	for range 3 {
		res, err := newLLM().Inference(ctx, scenario.InferenceParams{
			Model:      "gpt-4.1-mini",
			Messages:   msgs,
			Tools:      []scenario.ToolDefinition{orderTool},
			ToolChoice: &scenario.ToolChoice{Type: scenario.ToolChoiceAuto},
		})
		if err != nil {
			return "", err
		}
		last = res.Message.Content
		if len(res.Message.ToolCalls) == 0 {
			break
		}
		msgs = append(msgs, res.Message)
		for _, call := range res.Message.ToolCalls {
			msgs = append(msgs, scenario.ToolMsg(call.ID, lookupOrderStatus(ctx, call)))
		}
	}
	return last, nil
}

// newOrderSupportServer serves POST /chat. It adopts the trace context of the
// request, so every span of the answer joins the scenario turn's trace;
// standard OTel HTTP middleware (otelhttp) does the same.
func newOrderSupportServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		answer, err := answerOrderQuestion(ctx, fromWire(req.Messages))
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(chatResponse{Response: answer})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentTraces(t *testing.T) {
	skipWithoutOpenAI(t)
	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	srv := newOrderSupportServer(t)

	remoteAgent := scenario.AgentFunc(func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		var res chatResponse
		// Forward the turn's trace context (traceparent, tracestate).
		err := postJSON(ctx, srv.URL+"/chat", input.PropagationHeaders, chatRequest{Messages: toWire(input.Messages)}, &res)
		if err != nil {
			return nil, err
		}
		return scenario.TextReturn(res.Response), nil
	})

	fetchRemoteTraces := true
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Remote agent trace judging",
		Description: "A customer asks where order ORD-1042 is. The agent must check the order system before answering.",
		Agents: []scenario.AgentAdapter{
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			remoteAgent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Where is my order ORD-1042?"),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"The agent tells the user the current status of their order",
				"The agent looked the order up in the order system (a lookup_order_status tool span exists)",
			)),
		},
		MaxTurns: 5,
		// Judge on the remote agent's traces in LangWatch (needs
		// LANGWATCH_API_KEY). Without a key the judge still sees the spans,
		// because this server runs in the test process.
		FetchRemoteTraces: &fetchRemoteTraces,
		TraceWaitTimeout:  30 * time.Second,
		SetID:             "go-examples",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}
}
