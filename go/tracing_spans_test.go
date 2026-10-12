package scenario

import (
	"context"
	"reflect"
	"testing"

	langwatch "github.com/langwatch/langwatch/sdks/go"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/langwatch/scenario/go/internal/spandigest"
)

// TestSpanStarterMatchesLangWatchTracer pins that the executor's spans carry
// exactly the attributes, in exactly the order, they had when they were
// started on langwatch.Tracer and the span type and input were set after
// the start, so the judge's span digest renders them identically.
func TestSpanStarterMatchesLangWatchTracer(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	old := langwatch.TracerFromProvider(tp, TracerName, trace.WithInstrumentationVersion(Version))
	starter := spanStarter{tracer: tp.Tracer(TracerName, trace.WithInstrumentationVersion(Version))}
	ctx := context.Background()
	cfg := ScenarioConfig{Name: "name", ID: "scenario-id", ThreadID: "thread"}
	const input = `{"type":"chat_messages","value":[{"role":"user","content":"hi"}]}`

	// The pairs below are (previous code, new code), started in order.
	_, s := old.Start(ctx, "Scenario Run", trace.WithAttributes(
		attribute.String("langwatch.origin", "simulation"),
		sdkAttributes[0], sdkAttributes[1],
		attribute.String("scenario.run_id", "run"),
		attribute.String("scenario.name", cfg.Name),
		attribute.String("scenario.id", cfg.ID),
		attribute.String(threadIDKey, cfg.ThreadID),
	))
	s.End()
	_, s = starter.start(ctx, "Scenario Run", runSpanAttributes("run", cfg, -1))
	s.End()

	_, s = old.Start(ctx, "Scenario Turn", trace.WithAttributes(
		attribute.String("langwatch.origin", "simulation"),
		sdkAttributes[0], sdkAttributes[1],
		attribute.String("scenario.run_id", "run"),
		attribute.String("scenario.name", cfg.Name),
		attribute.String("scenario.id", cfg.ID),
		attribute.String(threadIDKey, cfg.ThreadID),
		attribute.Int("scenario.turn", 3),
	))
	s.End()
	_, s = starter.start(ctx, "Scenario Turn", runSpanAttributes("run", cfg, 3))
	s.End()

	oldAgentSpan := func() {
		_, s := old.Start(ctx, "echoAgent.call", trace.WithAttributes(
			attribute.String(threadIDKey, cfg.ThreadID),
			attribute.String("scenario.role", string(AgentRoleAgent)),
		))
		s.SetType(langwatch.SpanTypeAgent)
		s.SetAttributes(langwatch.AttributeLangWatchInput.String(input))
		s.End()
	}
	oldAgentSpan()
	// Input known at start (the parent records).
	_, s = starter.start(ctx, "echoAgent.call", agentSpanAttributes(cfg.ThreadID, AgentRoleAgent, input, true))
	s.End()
	oldAgentSpan()
	// Input set after the start (the parent did not record).
	_, s = starter.start(ctx, "echoAgent.call", agentSpanAttributes(cfg.ThreadID, AgentRoleAgent, "", false))
	s.SetAttributes(langwatch.AttributeLangWatchInput.String(input))
	s.End()

	ended := rec.Ended()
	if len(ended) != 8 {
		t.Fatalf("got %d spans", len(ended))
	}
	for i := 0; i < len(ended); i += 2 {
		want, got := ended[i], ended[i+1]
		if !reflect.DeepEqual(got.Attributes(), want.Attributes()) {
			t.Errorf("%s attributes\n got %v\nwant %v", want.Name(), got.Attributes(), want.Attributes())
		}
		if !reflect.DeepEqual(got.InstrumentationScope(), want.InstrumentationScope()) {
			t.Errorf("%s scope %+v, want %+v", want.Name(), got.InstrumentationScope(), want.InstrumentationScope())
		}
		// The digest of the two spans, with identity and timing aligned,
		// is the same text.
		ws, gs := tracetest.SpanStubFromReadOnlySpan(want), tracetest.SpanStubFromReadOnlySpan(got)
		gs.SpanContext, gs.Parent, gs.StartTime, gs.EndTime = ws.SpanContext, ws.Parent, ws.StartTime, ws.EndTime
		wd := spandigest.Format([]sdktrace.ReadOnlySpan{ws.Snapshot()})
		gd := spandigest.Format([]sdktrace.ReadOnlySpan{gs.Snapshot()})
		if gd != wd {
			t.Errorf("%s digest\n got %s\nwant %s", want.Name(), gd, wd)
		}
	}
}
