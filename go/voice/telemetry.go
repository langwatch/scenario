package voice

import (
	"context"
	"fmt"
	"log/slog"

	scenario "github.com/langwatch/scenario/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Span names of the voice runtime. Adapters add attributes to these spans
// (disambiguated by voice.adapter.class) rather than opening vendor-named
// ones.
const (
	SpanAdapterConnect    = "voice.adapter.connect"
	SpanAdapterDisconnect = "voice.adapter.disconnect"
	SpanAdapterInterrupt  = "voice.adapter.interrupt"
	SpanTurn              = "voice.turn"
	SpanAudioSend         = "voice.audio.send"
	SpanAudioReceive      = "voice.audio.receive"
	SpanSTTBackfill       = "voice.stt.backfill"
	SpanSTTTranscribe     = "voice.stt.transcribe"
)

func tracer() trace.Tracer { return otel.Tracer(scenario.TracerName) }

// StartSpan opens a voice span as a child of ctx's span, typed
// langwatch.span.type=span. Close it with [EndSpan].
func StartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	ctx, span := tracer().Start(ctx, name)
	if span.IsRecording() {
		span.SetAttributes(attribute.String("langwatch.span.type", "span"))
		span.SetAttributes(attrs...)
	}
	return ctx, span
}

// EndSpan ends a voice span: an error is recorded and sets the status ERROR,
// otherwise the status is OK. A panicking span processor is recovered and
// logged, so telemetry never breaks a voice run.
func EndSpan(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	} else {
		span.SetStatus(codes.Ok, "")
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Default().Warn("voice: span failed to export; dropping it (run continues)", "error", fmt.Sprint(r))
		}
	}()
	span.End()
}

// withSpan runs fn inside a voice span.
func withSpan(ctx context.Context, name string, attrs []attribute.KeyValue, fn func(context.Context, trace.Span) error) error {
	ctx, span := StartSpan(ctx, name, attrs...)
	err := fn(ctx, span)
	EndSpan(span, err)
	return err
}

// SetSpanAttributes sets attributes on a recording span; it never panics.
func SetSpanAttributes(span trace.Span, attrs ...attribute.KeyValue) {
	if span == nil || !span.IsRecording() {
		return
	}
	defer func() { _ = recover() }()
	span.SetAttributes(attrs...)
}

// adapterAttrs are the attributes identifying an adapter on its spans.
func adapterClass(name string) attribute.KeyValue {
	return attribute.String("voice.adapter.class", name)
}

type traceSpan = trace.Span
