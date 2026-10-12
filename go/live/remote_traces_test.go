//go:build integration

package live_test

import (
	"context"
	"sync"
	"testing"
	"time"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/livetest"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// recordingFetcher records what the real remote trace fetcher concluded.
type recordingFetcher struct {
	scenario.RemoteTraceFetcher
	mu      sync.Mutex
	waits   int
	settled bool
}

func (f *recordingFetcher) SettleWait(ctx context.Context, target scenario.TraceSettleTarget) bool {
	ok := f.RemoteTraceFetcher.SettleWait(ctx, target)
	f.mu.Lock()
	f.waits++
	f.settled = ok
	f.mu.Unlock()
	return ok
}

// TestLiveJudgeFetchesRemoteTraces is the live twin of the JavaScript
// remote-traces integration test: the agent's evidence exists only in
// spans another process exported to LangWatch (here a second tracer
// provider standing in for a remote service, joined to the turn's trace),
// and the judge must fetch them through the trace API to pass. Needs
// LANGWATCH_API_KEY and OPENAI_API_KEY.
func TestLiveJudgeFetchesRemoteTraces(t *testing.T) {
	lw := livetest.RequireLangWatch(t)
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, readBackTimeout)

	exp, err := langwatch.NewExporter(ctx,
		langwatch.WithAPIKey(lw.Config.APIKey),
		langwatch.WithEndpoint(lw.Config.Endpoint),
		langwatch.WithProjectID(lw.Config.ProjectID))
	if err != nil {
		t.Fatal(err)
	}
	remote := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))
	t.Cleanup(func() { _ = remote.Shutdown(context.Background()) })

	agent := scenario.AgentFunc(func(ctx context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
		// The "remote service": its span joins the agent call's trace but
		// never enters this process's span collector.
		_, span := remote.Tracer("remote-order-service").Start(ctx, "db.write_orders")
		span.SetAttributes(
			attribute.String("langwatch.span.type", "tool"),
			attribute.String("langwatch.input", `{"type":"json","value":{"table":"orders","order_id":"A-1042"}}`),
			attribute.String("langwatch.output", `{"type":"text","value":"1 row written"}`),
		)
		time.Sleep(50 * time.Millisecond)
		span.End()
		if err := remote.ForceFlush(ctx); err != nil {
			return nil, err
		}
		return scenario.TextReturn("Done."), nil
	})
	fetcher := &recordingFetcher{RemoteTraceFetcher: scenario.DefaultRemoteTraceFetcher()}
	criteria := []string{"The agent wrote order A-1042 to the orders table (a db.write_orders span shows it)"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live: judge reads remote traces",
		Description: "A user asks the agent to save order A-1042.",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: modelConfig(llm), Criteria: criteria, TraceFetcher: fetcher}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Please save my order A-1042."),
			scenario.Agent(),
			scenario.Judge(),
		},
		FetchRemoteTraces: ptr(true),
		TraceWaitTimeout:  90 * time.Second,
		SetID:             livetest.SetID,
	}, scenario.WithLangWatch(lw.Config))

	fetcher.mu.Lock()
	waits, settled := fetcher.waits, fetcher.settled
	fetcher.mu.Unlock()
	if waits == 0 || !settled {
		t.Errorf("remote trace fetch: %d waits, settled %v", waits, settled)
	}
	livetest.AssertVerdict(t, res, err, criteria)
}
