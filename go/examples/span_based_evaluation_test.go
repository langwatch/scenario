// Example: Span-Based Evaluation
//
// The judge reads the agent's OpenTelemetry spans, not only the
// conversation: a fraud check HTTP call, a database query and a tool call
// are recorded as spans and judged as criteria. Spans started from the ctx
// an agent receives join the scenario's trace; the SDK sets up tracing on
// the first run (call scenario.SetupScenarioTracing first to customize it).
//
// Mirrors: javascript/examples/vitest/tests/span-based-evaluation.test.ts
package examples

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

var orderTracer = otel.Tracer("order-processing-agent")

// checkInventoryTool is the tool the order agent may call.
var checkInventoryTool = scenario.ToolDefinition{
	Name:        "check_inventory",
	Description: "Check if an item is in stock",
	Parameters: map[string]any{
		"type": "object",
		"properties": map[string]any{
			"productId": map[string]any{"type": "string", "description": "The product ID to check"},
		},
		"required": []string{"productId"},
	},
}

// observableAgent records custom spans while it answers.
type observableAgent struct {
	inner scenario.AgentAdapter
}

func (observableAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a observableAgent) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	// ctx carries the agent call span, so these spans are its children.
	_, fraud := orderTracer.Start(ctx, "http.fraud_check")
	fraud.SetAttributes(
		attribute.String("http.method", "POST"),
		attribute.String("http.url", "https://api.fraudservice.com/check"),
		attribute.Int("http.status_code", 200),
	)
	time.Sleep(30 * time.Millisecond)
	fraud.SetAttributes(attribute.Float64("fraud.risk_score", 0.1))
	fraud.End()

	_, db := orderTracer.Start(ctx, "db.query")
	db.SetAttributes(
		attribute.String("db.system", "postgresql"),
		attribute.String("db.operation", "SELECT"),
		attribute.String("db.statement", "SELECT * FROM customers WHERE id = $1"),
	)
	time.Sleep(20 * time.Millisecond)
	db.End()

	return a.inner.Call(ctx, in)
}

func TestSpanBasedEvaluation(t *testing.T) {
	skipWithoutOpenAI(t)

	inventory := simpleAgent(
		"You are an order processing assistant. When asked about products, use the check_inventory tool.",
		[]scenario.ToolDefinition{checkInventoryTool},
		func(tc scenario.ToolCall) (string, error) {
			var args struct {
				ProductID string `json:"productId"`
			}
			if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
				return "", err
			}
			out, err := json.Marshal(map[string]any{"inStock": true, "quantity": 42, "productId": args.ProductID})
			return string(out), err
		},
	)

	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "span-based evaluation demo",
		Description: "A customer asks about product SKU-123 availability. The agent should check inventory and respond.",
		Agents: []scenario.AgentAdapter{
			observableAgent{inner: inventory},
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: model}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Is product SKU-123 in stock?"),
			scenario.Agent(),
			scenario.Judge(scenario.WithCriteria(
				"A fraud check HTTP call was made (http.fraud_check span exists)",
				"A database query was performed (db.query span exists)",
				"The check_inventory tool was called for the product",
			)),
		},
		MaxTurns: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}
}
