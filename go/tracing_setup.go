package scenario

import (
	"context"

	langwatch "github.com/langwatch/langwatch/sdk-go"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// ObservabilityHandle holds the OTel tracing infrastructure.
type ObservabilityHandle struct {
	provider  *sdktrace.TracerProvider
	tracer    *langwatch.LangWatchTracer
	collector *SpanCollector
}

// setupObservability initializes the OTel tracing infrastructure with LangWatch.
func setupObservability(ctx context.Context, endpoint, apiKey string) (*ObservabilityHandle, error) {
	collector := NewSpanCollector()

	opts := []langwatch.ExporterOption{
		langwatch.WithAPIKey(apiKey),
	}
	if endpoint != "" {
		opts = append(opts, langwatch.WithEndpoint(endpoint))
	}

	exporter, err := langwatch.NewDefaultExporter(ctx, opts...)
	if err != nil {
		return nil, err
	}

	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithSpanProcessor(collector),
	)
	otel.SetTracerProvider(provider)

	tracer := langwatch.Tracer("@langwatch/scenario")

	return &ObservabilityHandle{
		provider:  provider,
		tracer:    tracer,
		collector: collector,
	}, nil
}

// Shutdown flushes and shuts down the tracing provider.
func (h *ObservabilityHandle) Shutdown(ctx context.Context) {
	if h.provider != nil {
		_ = h.provider.Shutdown(ctx)
	}
}
