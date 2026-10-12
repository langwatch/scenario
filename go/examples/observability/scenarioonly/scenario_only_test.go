// Example: Custom Observability, Scenario Spans Only
//
// A process with spans of its own (HTTP handlers, middleware) exports only the
// scenario's spans to LangWatch with the ScenarioOnly filter. Tracing is set
// up once per process, so this example is a package of its own.
//
// Mirrors: javascript/examples/custom-observability/test-scenario-only.ts
package scenarioonly

import (
	"context"
	"testing"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// inlineUser stands in for the user simulator; the script supplies every
// user message, so Call never runs.
type inlineUser struct{}

func (inlineUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }

func (inlineUser) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, nil
}

func TestScenarioOnly(t *testing.T) {
	ctx := context.Background()
	filter := scenario.ScenarioOnly()

	// Capture every span in memory. The filter applies to the LangWatch
	// exporter only, disabled here to keep the example local.
	exporter := tracetest.NewInMemoryExporter()
	err := scenario.SetupScenarioTracing(scenario.TracingOptions{
		Filters:                  []langwatch.Filter{filter},
		SpanProcessors:           []sdktrace.SpanProcessor{sdktrace.NewSimpleSpanProcessor(exporter)},
		DisableLangWatchExporter: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Server noise the filter must keep out of LangWatch.
	noise := otel.Tracer("http-server")
	for _, name := range []string{"GET /api/health", "middleware PUT /api/inngest"} {
		_, span := noise.Start(ctx, name)
		span.End()
	}

	echo := scenario.AgentFunc(func(_ context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("Echo: " + input.Messages[len(input.Messages)-1].Text()), nil
	})
	result, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "observability-test",
		Description: "Test that scenarioOnly filtering works",
		Agents:      []scenario.AgentAdapter{echo, inlineUser{}},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you hear me?"),
			scenario.Agent(),
			scenario.Succeed(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", result.Reasoning)
	}

	spans := exporter.GetSpans().Snapshots()
	byScope := map[string]int{}
	for _, s := range spans {
		byScope[s.InstrumentationScope().Name]++
	}
	if byScope[scenario.TracerName] == 0 {
		t.Fatalf("no %s spans were collected", scenario.TracerName)
	}
	// Both noise spans must be collected, or "the filter dropped them" would
	// hold for the wrong reason.
	if byScope["http-server"] != 2 {
		t.Fatalf("expected the 2 http-server spans to be collected, found %d", byScope["http-server"])
	}

	// What LangWatch would receive: every scenario span and no noise.
	exported := filter.Apply(spans)
	for _, s := range exported {
		if scope := s.InstrumentationScope().Name; scope != scenario.TracerName {
			t.Errorf("ScenarioOnly kept span %q of scope %q", s.Name(), scope)
		}
	}
	if len(exported) != byScope[scenario.TracerName] {
		t.Errorf("ScenarioOnly kept %d of the %d scenario spans", len(exported), byScope[scenario.TracerName])
	}
}
