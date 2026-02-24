package scenario

import (
	"fmt"
	"sort"
	"strings"
	"time"

	langwatch "github.com/langwatch/langwatch/sdk-go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// spanNode represents a span in the hierarchy tree.
type spanNode struct {
	span     sdktrace.ReadOnlySpan
	children []*spanNode
}

// SpanDigestFormatter converts OTel spans to plain-text for judge evaluation.
type SpanDigestFormatter struct{}

// Format transforms spans into a complete digest with full content and nesting.
func (f *SpanDigestFormatter) Format(spans []sdktrace.ReadOnlySpan) string {
	if len(spans) == 0 {
		return "No spans recorded."
	}

	sorted := f.sortByStartTime(spans)
	tree := f.buildHierarchy(sorted)
	totalDuration := f.calculateTotalDuration(sorted)

	lines := []string{
		fmt.Sprintf("Spans: %d | Total Duration: %s", len(spans), f.formatDuration(totalDuration)),
		"",
	}

	seq := 1
	rootCount := len(tree)
	for i, node := range tree {
		seq = f.renderNode(node, &lines, 0, seq, i == rootCount-1)
	}

	errors := f.collectErrors(spans)
	if len(errors) > 0 {
		lines = append(lines, "")
		lines = append(lines, "=== ERRORS ===")
		lines = append(lines, errors...)
	}

	return strings.Join(lines, "\n")
}

func (f *SpanDigestFormatter) sortByStartTime(spans []sdktrace.ReadOnlySpan) []sdktrace.ReadOnlySpan {
	sorted := make([]sdktrace.ReadOnlySpan, len(spans))
	copy(sorted, spans)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].StartTime().Before(sorted[j].StartTime())
	})
	return sorted
}

func (f *SpanDigestFormatter) buildHierarchy(spans []sdktrace.ReadOnlySpan) []*spanNode {
	spanMap := make(map[string]*spanNode)
	var roots []*spanNode

	for _, s := range spans {
		spanMap[s.SpanContext().SpanID().String()] = &spanNode{span: s}
	}

	for _, s := range spans {
		node := spanMap[s.SpanContext().SpanID().String()]
		parentID := s.Parent().SpanID().String()

		if parent, ok := spanMap[parentID]; ok {
			parent.children = append(parent.children, node)
		} else {
			roots = append(roots, node)
		}
	}

	return roots
}

func (f *SpanDigestFormatter) renderNode(node *spanNode, lines *[]string, depth, seq int, isLast bool) int {
	span := node.span
	duration := span.EndTime().Sub(span.StartTime())
	timestamp := span.StartTime().UTC().Format(time.RFC3339Nano)
	status := f.getStatusIndicator(span)

	prefix := f.getTreePrefix(depth, isLast)
	*lines = append(*lines, fmt.Sprintf("%s[%d] %s %s (%s)%s",
		prefix, seq, timestamp, span.Name(), f.formatDuration(duration), status))

	attrIndent := f.getAttrIndent(depth, isLast)
	attrs := f.cleanAttributes(span)
	for _, kv := range attrs {
		*lines = append(*lines, fmt.Sprintf("%s%s: %s", attrIndent, kv.key, kv.value))
	}

	for _, event := range span.Events() {
		*lines = append(*lines, fmt.Sprintf("%s[event] %s", attrIndent, event.Name))
		eventAttrs := f.cleanEventAttributes(event)
		for _, kv := range eventAttrs {
			*lines = append(*lines, fmt.Sprintf("%s  %s: %s", attrIndent, kv.key, kv.value))
		}
	}

	*lines = append(*lines, "")

	nextSeq := seq + 1
	childCount := len(node.children)
	for i, child := range node.children {
		nextSeq = f.renderNode(child, lines, depth+1, nextSeq, i == childCount-1)
	}

	return nextSeq
}

func (f *SpanDigestFormatter) getTreePrefix(depth int, isLast bool) string {
	if depth == 0 {
		return ""
	}
	connector := "├── "
	if isLast {
		connector = "└── "
	}
	return strings.Repeat("│   ", depth-1) + connector
}

func (f *SpanDigestFormatter) getAttrIndent(depth int, isLast bool) string {
	if depth == 0 {
		return "    "
	}
	continuation := "│   "
	if isLast {
		continuation = "    "
	}
	return strings.Repeat("│   ", depth-1) + continuation + "    "
}

type keyValue struct {
	key   string
	value string
}

// excludedAttrKeys are attributes filtered out from the digest.
var excludedAttrKeys = map[attribute.Key]bool{
	langwatch.AttributeLangWatchThreadID: true,
	"langwatch.scenario.id":             true,
	"langwatch.scenario.name":           true,
}

func (f *SpanDigestFormatter) cleanAttributes(span sdktrace.ReadOnlySpan) []keyValue {
	var result []keyValue
	seen := make(map[string]bool)

	for _, attr := range span.Attributes() {
		if excludedAttrKeys[attr.Key] {
			continue
		}
		key := string(attr.Key)
		// Strip langwatch. prefix for cleaner display
		cleanKey := strings.TrimPrefix(key, "langwatch.")
		if seen[cleanKey] {
			continue
		}
		seen[cleanKey] = true
		result = append(result, keyValue{key: cleanKey, value: attr.Value.Emit()})
	}
	return result
}

func (f *SpanDigestFormatter) cleanEventAttributes(event sdktrace.Event) []keyValue {
	var result []keyValue
	seen := make(map[string]bool)

	for _, attr := range event.Attributes {
		if excludedAttrKeys[attr.Key] {
			continue
		}
		key := string(attr.Key)
		cleanKey := strings.TrimPrefix(key, "langwatch.")
		if seen[cleanKey] {
			continue
		}
		seen[cleanKey] = true
		result = append(result, keyValue{key: cleanKey, value: attr.Value.Emit()})
	}
	return result
}

func (f *SpanDigestFormatter) calculateTotalDuration(spans []sdktrace.ReadOnlySpan) time.Duration {
	if len(spans) == 0 {
		return 0
	}
	first := spans[0].StartTime()
	last := spans[0].EndTime()
	for _, s := range spans[1:] {
		if s.EndTime().After(last) {
			last = s.EndTime()
		}
	}
	return last.Sub(first)
}

func (f *SpanDigestFormatter) formatDuration(d time.Duration) string {
	ms := d.Milliseconds()
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.2fs", d.Seconds())
}

func (f *SpanDigestFormatter) getStatusIndicator(span sdktrace.ReadOnlySpan) string {
	if span.Status().Code == codes.Error {
		msg := span.Status().Description
		if msg == "" {
			msg = "unknown"
		}
		return " ERROR: " + msg
	}
	return ""
}

func (f *SpanDigestFormatter) collectErrors(spans []sdktrace.ReadOnlySpan) []string {
	var errors []string
	for _, s := range spans {
		if s.Status().Code == codes.Error {
			msg := s.Status().Description
			if msg == "" {
				msg = "unknown error"
			}
			errors = append(errors, fmt.Sprintf("- %s: %s", s.Name(), msg))
		}
	}
	return errors
}
