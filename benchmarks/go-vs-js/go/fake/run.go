package fake

import (
	"context"
	"fmt"
	"sync/atomic"

	scenario "github.com/langwatch/scenario/go"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// Exporter is the in-memory span exporter both benchmark programs install.
// It sits behind a simple (synchronous) span processor, as the JS SDK puts
// its traceExporter option behind a SimpleSpanProcessor.
var Exporter = tracetest.NewInMemoryExporter()

// Setup configures tracing and the SDK once per process: the span
// collector the judge reads, plus the in-memory exporter, and no LangWatch
// trace exporter. The browser is never opened.
func Setup() error {
	scenario.Configure(scenario.WithHeadless(true))
	return scenario.SetupScenarioTracing(scenario.TracingOptions{
		SpanProcessors:           []sdktrace.SpanProcessor{sdktrace.NewSimpleSpanProcessor(Exporter)},
		DisableLangWatchExporter: true,
	})
}

var batchSeq atomic.Int64

// RunFull runs the full scenario once: ten turns of user simulator, agent
// (two model calls and one tool call per turn) and judge, with events
// posted to sinkURL. It checks the outcome so a broken setup cannot pass as
// a fast one, and returns the number of messages of the run.
func RunFull(ctx context.Context, sinkURL string) (int, error) {
	llm := NewLLM()
	cfg := scenario.ScenarioConfig{
		Name:        "go-vs-js full scenario",
		Description: Description,
		MaxTurns:    MaxTurns,
		SetID:       "go-vs-js",
		Agents: []scenario.AgentAdapter{
			&Agent{LLM: llm},
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: ModelName}}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: scenario.ModelConfig{LLM: llm, Model: ModelName}, Criteria: []string{Criterion}}),
		},
	}
	opts := []scenario.RunOption{scenario.WithQuiet(), scenario.WithBatchRunID(fmt.Sprintf("batch_go_vs_js_%d", batchSeq.Add(1)))}
	if sinkURL != "" {
		opts = append(opts, scenario.WithLangWatch(scenario.LangWatchConfig{Endpoint: sinkURL, APIKey: "sk-lw-bench"}))
	}
	res, err := scenario.Run(ctx, cfg, opts...)
	if err != nil {
		return 0, err
	}
	if !res.Success {
		return 0, fmt.Errorf("scenario did not pass: %s", res.Reasoning)
	}
	// Ten turns of user, tool call, tool result and answer is 40; the
	// report prints the count of both SDKs side by side as a parity check.
	return len(res.Messages), nil
}

// RunTrivial runs the cold start scenario: one scripted user message, one
// agent answer without a model, and success. No events are posted. A
// scripted user line still needs an agent with the user role in the list
// (on both SDKs), so a user simulator over the scripted model is there; it
// is never asked for a message.
func RunTrivial(ctx context.Context) error {
	user := scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: scenario.ModelConfig{LLM: NewLLM(), Model: ModelName}})
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go-vs-js cold start",
		Description: Description,
		Agents:      []scenario.AgentAdapter{EchoAgent{}, user},
		Script:      []scenario.ScriptStep{scenario.User(UserText), scenario.Agent(), scenario.Succeed("done")},
	}, scenario.WithQuiet())
	if err != nil {
		return err
	}
	if !res.Success || len(res.Messages) != 2 {
		return fmt.Errorf("cold start scenario: success=%v messages=%d", res.Success, len(res.Messages))
	}
	return nil
}
