// Example: Custom Observability, App-Owned Tracer Provider
//
// Importing the scenario package installs no tracer provider. An app that
// sets its own before the first run keeps it: scenario attaches its span
// collector to that provider and its spans reach the app's exporter.
// Tracing is set up once per process, so this example is a package of its own.
//
// Mirrors: javascript/examples/custom-observability/test-no-auto-init.ts
package noautoinit

import (
	"context"
	"testing"

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

func TestNoAutoInit(t *testing.T) {
	ctx := context.Background()

	// Package initialization has run by now: the global provider must still
	// be the OTel no-op default.
	if p, ok := otel.GetTracerProvider().(*sdktrace.TracerProvider); ok {
		t.Fatalf("importing scenario installed a tracer provider: %T", p)
	}

	// The app owns its provider and sets it before the first run.
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(ctx) })

	echo := scenario.AgentFunc(func(_ context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("Echo: " + input.Messages[len(input.Messages)-1].Text()), nil
	})
	result, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "app-owned-provider-test",
		Description: "Test that scenario attaches to the app's tracer provider",
		Agents:      []scenario.AgentAdapter{echo, inlineUser{}},
		Script: []scenario.ScriptStep{
			scenario.User("Hello"),
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

	if got := otel.GetTracerProvider(); got != provider {
		t.Fatalf("the run replaced the app's tracer provider with %T", got)
	}
	var scenarioSpans int
	for _, s := range exporter.GetSpans() {
		if s.InstrumentationScope.Name == scenario.TracerName {
			scenarioSpans++
		}
	}
	if scenarioSpans == 0 {
		t.Fatal("no scenario spans reached the app's exporter")
	}
}
