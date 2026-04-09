package scenario

import (
	"context"
	"sync"

	langwatch "github.com/langwatch/langwatch/sdk-go"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// SpanCollector implements sdktrace.SpanProcessor to collect spans for judge evaluation.
type SpanCollector struct {
	mu    sync.Mutex
	spans []sdktrace.ReadOnlySpan
}

// NewSpanCollector creates a new SpanCollector.
func NewSpanCollector() *SpanCollector {
	return &SpanCollector{}
}

func (c *SpanCollector) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {}

func (c *SpanCollector) OnEnd(s sdktrace.ReadOnlySpan) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spans = append(c.spans, s)
}

func (c *SpanCollector) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spans = nil
	return nil
}

func (c *SpanCollector) ForceFlush(ctx context.Context) error {
	return nil
}

// GetSpansForThread returns all spans associated with the given thread ID.
// It checks span attributes for the LangWatch thread ID and walks the parent chain.
func (c *SpanCollector) GetSpansForThread(threadID string) []sdktrace.ReadOnlySpan {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Index spans by spanID for parent chain walking
	spanMap := make(map[string]sdktrace.ReadOnlySpan)
	for _, span := range c.spans {
		spanMap[span.SpanContext().SpanID().String()] = span
	}

	var result []sdktrace.ReadOnlySpan
	for _, span := range c.spans {
		if belongsToThread(span, threadID, spanMap) {
			result = append(result, span)
		}
	}
	return result
}

// belongsToThread checks if a span or any of its ancestors has the given thread ID.
func belongsToThread(span sdktrace.ReadOnlySpan, threadID string, spanMap map[string]sdktrace.ReadOnlySpan) bool {
	// Check this span's attributes
	for _, attr := range span.Attributes() {
		if attr.Key == langwatch.AttributeLangWatchThreadID && attr.Value.AsString() == threadID {
			return true
		}
	}

	// Walk parent chain
	parentID := span.Parent().SpanID().String()
	if parent, ok := spanMap[parentID]; ok && parent.SpanContext().SpanID() != span.SpanContext().SpanID() {
		return belongsToThread(parent, threadID, spanMap)
	}

	return false
}
