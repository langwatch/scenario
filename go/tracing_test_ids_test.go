package scenario

import (
	"context"
	"encoding/binary"
	"sync/atomic"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// testIDs generates span and trace ids from a counter, so golden payloads
// that carry trace ids are deterministic. It is installed as the global
// provider's generator before the SDK attaches to it.
type testIDs struct{}

var testIDCounter atomic.Uint64

func (testIDs) NewIDs(context.Context) (trace.TraceID, trace.SpanID) {
	var tid trace.TraceID
	n := testIDCounter.Add(1)
	binary.BigEndian.PutUint64(tid[8:], n)
	tid[0] = 0xab
	return tid, spanIDFor(n)
}

func (testIDs) NewSpanID(context.Context, trace.TraceID) trace.SpanID {
	return spanIDFor(testIDCounter.Add(1))
}

func spanIDFor(n uint64) trace.SpanID {
	var sid trace.SpanID
	binary.BigEndian.PutUint64(sid[:], n)
	sid[0] = 0xcd
	return sid
}

func installTestProvider() *sdktrace.TracerProvider {
	tp := sdktrace.NewTracerProvider(sdktrace.WithIDGenerator(testIDs{}))
	otel.SetTracerProvider(tp)
	return tp
}
