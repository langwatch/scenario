package spandigest

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// benchSpans is the same span set the baseline benchmark of the previous
// implementation used: 50 spans in a tree, JSON inputs, some errors.
func benchSpans(n int) []sdktrace.ReadOnlySpan {
	var tid trace.TraceID
	tid[0] = 1
	start := time.Unix(1700000000, 0)
	stubs := make(tracetest.SpanStubs, 0, n)
	for i := 0; i < n; i++ {
		var sid, pid trace.SpanID
		sid[7] = byte(i + 1)
		sid[6] = byte((i + 1) >> 8)
		parent := trace.SpanContext{}
		if i > 0 {
			pid[7] = byte((i-1)/3 + 1)
			parent = trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: pid})
		}
		st := tracetest.SpanStub{
			Name:        fmt.Sprintf("span-%d", i),
			SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid}),
			Parent:      parent,
			StartTime:   start.Add(time.Duration(i) * time.Millisecond),
			EndTime:     start.Add(time.Duration(i+5) * time.Millisecond),
			Attributes: []attribute.KeyValue{
				attribute.String("langwatch.span.type", "llm"),
				attribute.String("gen_ai.request.model", "gpt-4o-mini"),
				attribute.String("langwatch.input", `{"type":"chat_messages","value":[{"role":"user","content":"`+strings.Repeat("hello world ", 20)+`"}]}`),
				attribute.String("langwatch.output", `{"type":"text","value":"`+strings.Repeat("answer ", 30)+`"}`),
				attribute.Int("gen_ai.usage.input_tokens", 120),
			},
		}
		if i%10 == 9 {
			st.Status = sdktrace.Status{Code: codes.Error, Description: "boom"}
		}
		stubs = append(stubs, st)
	}
	return stubs.Snapshots()
}

func BenchmarkDigestFormat50(b *testing.B) {
	spans := benchSpans(50)
	b.ReportAllocs()
	for b.Loop() {
		_ = Format(spans)
	}
}

func BenchmarkDigestStructureOnly50(b *testing.B) {
	spans := benchSpans(50)
	b.ReportAllocs()
	for b.Loop() {
		_ = FormatStructureOnly(spans)
	}
}
