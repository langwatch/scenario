package scenario

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func processTraceCount(c *SpanCollector) int {
	n := 0
	for i := range c.traces {
		sh := &c.traces[i]
		sh.mu.Lock()
		n += len(sh.processSpans)
		sh.mu.Unlock()
	}
	return n
}

// Traces of unrelated instrumentation, which no thread ever releases, are
// bounded; a scenario trace stays known as the process's own until
// ClearThread, and so does a recent unrelated one.
func TestCollectorBoundsUnthreadedProcessTraces(t *testing.T) {
	t.Parallel()
	c := NewSpanCollector()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(c))
	tr := tp.Tracer("test")

	ctx, root := tr.Start(context.Background(), "scenario", traceAttr("bounded-thread"))
	_, child := tr.Start(ctx, "agent")
	child.End()
	root.End()
	scenario := root.SpanContext()

	for range 3 * maxIdleTraces {
		ctx, s := tr.Start(context.Background(), "unrelated")
		_, inner := tr.Start(ctx, "inner")
		inner.End()
		s.End()
	}
	_, last := tr.Start(context.Background(), "recent")
	last.End()

	if n := processTraceCount(c); n > maxIdleTraces+1 {
		t.Fatalf("collector keeps %d traces, want at most %d", n, maxIdleTraces+1)
	}
	if !c.IsProcessSpan(scenario.TraceID(), scenario.SpanID()) {
		t.Fatal("a scenario trace must stay known until ClearThread")
	}
	if sc := last.SpanContext(); !c.IsProcessSpan(sc.TraceID(), sc.SpanID()) {
		t.Fatal("a recent unrelated trace must stay known")
	}
	c.ClearThread("bounded-thread")
	if c.IsProcessSpan(scenario.TraceID(), scenario.SpanID()) {
		t.Fatal("ClearThread must release the scenario trace")
	}
}

// A trace with a live span is never evicted, however many others end.
func TestCollectorKeepsTracesWithLiveSpans(t *testing.T) {
	t.Parallel()
	c := NewSpanCollector()
	tr := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(c)).Tracer("test")
	ctx, open := tr.Start(context.Background(), "open")
	_, done := tr.Start(ctx, "done")
	done.End()
	for range 2 * maxIdleTraces {
		_, s := tr.Start(context.Background(), "unrelated")
		s.End()
	}
	if sc := done.SpanContext(); !c.IsProcessSpan(sc.TraceID(), sc.SpanID()) {
		t.Fatal("a trace with a live span must stay known")
	}
	open.End()
}

func traceAttr(thread string) trace.SpanStartOption {
	return trace.WithAttributes(attribute.String(threadIDKey, thread))
}
