// Example: Custom Observability, Custom Scopes
//
// Exports the scenario's spans plus those of the app's own instrumented code
// (here, database calls) with WithCustomScopes, leaving other spans out.
// Tracing is set up once per process, so this example is a package of its own.
//
// Mirrors: javascript/examples/custom-observability/test-custom-scopes.ts
package customscopes

import (
	"context"
	"testing"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// dbScope is the instrumentation scope of the app's database calls.
const dbScope = "my-app/database"

// inlineUser stands in for the user simulator; the script supplies every
// user message, so Call never runs.
type inlineUser struct{}

func (inlineUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }

func (inlineUser) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, nil
}

func TestCustomScopes(t *testing.T) {
	ctx := context.Background()
	filter := scenario.WithCustomScopes(dbScope)

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

	// HTTP noise the filter must leave out.
	_, httpSpan := otel.Tracer("http-server").Start(ctx, "GET /api/health")
	httpSpan.End()

	// A database-backed agent: its query span nests under the agent call.
	db := otel.Tracer(dbScope)
	dbAgent := scenario.AgentFunc(func(ctx context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
		_, span := db.Start(ctx, "db.query SELECT users", trace.WithAttributes(
			attribute.String("db.statement", "SELECT * FROM users WHERE id = ?"),
			attribute.String("db.system", "postgresql"),
		))
		defer span.End()
		return scenario.TextReturn("Found user: Alice (from database)"), nil
	})

	result, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "custom-scopes-test",
		Description: "Test that custom scopes are captured alongside scenario spans",
		Agents:      []scenario.AgentAdapter{dbAgent, inlineUser{}},
		Script: []scenario.ScriptStep{
			scenario.User("Look up user Alice"),
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

	// What LangWatch would receive: the scenario and database spans, with
	// the database query in the scenario's trace, and no HTTP noise.
	byScope := map[string][]sdktrace.ReadOnlySpan{}
	for _, s := range filter.Apply(exporter.GetSpans().Snapshots()) {
		scope := s.InstrumentationScope().Name
		byScope[scope] = append(byScope[scope], s)
	}
	if len(byScope[scenario.TracerName]) == 0 || len(byScope[dbScope]) == 0 {
		t.Fatalf("expected scenario and database spans, got %d scenario and %d database spans",
			len(byScope[scenario.TracerName]), len(byScope[dbScope]))
	}
	if n := len(byScope["http-server"]); n != 0 {
		t.Errorf("WithCustomScopes kept %d http-server spans", n)
	}
	query := byScope[dbScope][0].SpanContext().TraceID()
	if run := byScope[scenario.TracerName][0].SpanContext().TraceID(); query != run {
		t.Errorf("database span is in trace %s, scenario spans in %s", query, run)
	}
}
