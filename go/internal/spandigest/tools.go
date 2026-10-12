package spandigest

import (
	"bytes"
	"encoding/hex"
	"strconv"
	"strings"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/langwatch/scenario/go/internal/jsstr"
)

const (
	// DefaultTokenThreshold is the estimated digest size above which the judge
	// receives the structure-only view plus the discovery tools.
	DefaultTokenThreshold = 8192
	// toolResultCharBudget caps a single tool result (~4096 tokens).
	toolResultCharBudget = 4096 * 4
	maxGrepMatches       = 20
	// LargeTraceHint follows the structure-only digest.
	LargeTraceHint = "\n\nUse expand_trace(span_id) to see span details or grep_trace(pattern) to search across spans. Reference spans by the ID shown in brackets."
)

// EstimateTokens estimates the token count of text as ceil(UTF-8 bytes / 4).
func EstimateTokens(text string) int {
	return (len(text) + 3) / 4
}

// ExpandTrace returns the full details of the spans whose id starts with one
// of the given prefixes.
func ExpandTrace(spans []sdktrace.ReadOnlySpan, spanIDs []string) string {
	if len(spans) == 0 {
		return NoSpans
	}
	if len(spanIDs) == 0 {
		return "Error: provide at least one span ID."
	}
	sorted := SortByStartTime(spans)
	var out lines
	var attrs []cleanAttribute
	matched := 0
	for _, s := range sorted {
		id := s.SpanContext().SpanID().String()
		hit := false
		for _, prefix := range spanIDs {
			if strings.HasPrefix(id, prefix) {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		matched++
		attrs = renderFullSpan(&out, s, attrs)
		out.add("")
	}
	if matched == 0 {
		var b strings.Builder
		b.WriteString("Error: no spans matched the given ID(s). Available span IDs: ")
		for i, s := range sorted {
			if i > 0 {
				b.WriteString(", ")
			}
			b.Write(AppendShortID(nil, s.SpanContext().SpanID()))
		}
		return b.String()
	}
	return truncateToCharBudget(string(bytes.TrimRight(out.buf, " \t\n\r")))
}

func renderFullSpan(out *lines, s sdktrace.ReadOnlySpan, attrs []cleanAttribute) []cleanAttribute {
	n := &node{span: s}
	r := renderer{}
	out.buf = r.header(out.start(), n, "", false)
	attrs = cleanAttributes(attrs, s.Attributes())
	for _, a := range attrs {
		out.add("    " + a.key + ": " + FormatValue(a.value))
	}
	for _, ev := range s.Events() {
		out.add("    [event] " + ev.Name)
		attrs = cleanAttributes(attrs, ev.Attributes)
		for _, a := range attrs {
			out.add("      " + a.key + ": " + FormatValue(a.value))
		}
	}
	return attrs
}

// searchableLines is the text grep_trace matches against, one entry per line.
func searchableLines(s sdktrace.ReadOnlySpan, attrs []cleanAttribute) ([]string, []cleanAttribute) {
	parts := []string{s.Name()}
	attrs = cleanAttributes(attrs, s.Attributes())
	for _, a := range attrs {
		parts = append(parts, a.key+": "+FormatValue(a.value))
	}
	for _, ev := range s.Events() {
		parts = append(parts, ev.Name)
		attrs = cleanAttributes(attrs, ev.Attributes)
		for _, a := range attrs {
			parts = append(parts, a.key+": "+FormatValue(a.value))
		}
	}
	return strings.Split(strings.Join(parts, "\n"), "\n"), attrs
}

// GrepTrace searches every span's name, attributes and events for pattern,
// case-insensitively, and lists the matching lines per span.
func GrepTrace(spans []sdktrace.ReadOnlySpan, pattern string) string {
	if len(spans) == 0 {
		return NoSpans
	}
	sorted := SortByStartTime(spans)
	needle := strings.ToLower(pattern)
	type match struct {
		span  sdktrace.ReadOnlySpan
		lines []string
	}
	var matches []match
	var attrs []cleanAttribute
	for _, s := range sorted {
		var all []string
		all, attrs = searchableLines(s, attrs)
		var hits []string
		for _, line := range all {
			if strings.Contains(strings.ToLower(line), needle) {
				hits = append(hits, line)
			}
		}
		if len(hits) > 0 {
			matches = append(matches, match{span: s, lines: hits})
		}
	}
	if len(matches) == 0 {
		var names []string
		seen := map[string]bool{}
		for _, s := range sorted {
			if !seen[s.Name()] {
				seen[s.Name()] = true
				names = append(names, s.Name())
			}
		}
		return `No matches found for "` + pattern + `". Available span names: ` + strings.Join(names, ", ")
	}
	var out lines
	for i, m := range matches {
		if i >= maxGrepMatches {
			break
		}
		b := out.start()
		b = append(b, "--- ["...)
		var id [8]byte
		sid := m.span.SpanContext().SpanID()
		hex.Encode(id[:], sid[:4])
		b = append(b, id[:]...)
		b = append(b, "] "...)
		b = append(b, m.span.Name()...)
		b = append(b, " ("...)
		b = appendDuration(b, SpanDurationMs(m.span))
		b = append(b, ") ---"...)
		out.buf = b
		for _, line := range m.lines {
			out.add("  " + line)
		}
		out.add("")
	}
	if len(matches) > maxGrepMatches {
		out.add("[" + strconv.Itoa(len(matches)-maxGrepMatches) + " more matches omitted. Refine your search pattern for more specific results.]")
	}
	return truncateToCharBudget(string(bytes.TrimRight(out.buf, " \t\n\r")))
}

func truncateToCharBudget(text string) string {
	if len(text) <= toolResultCharBudget || jsstr.Len(text) <= toolResultCharBudget {
		return text
	}
	return jsstr.Prefix(text, toolResultCharBudget) +
		"\n\n[TRUNCATED] Output exceeded ~4000 token budget. Use grep_trace(pattern) to search for specific content, or expand_trace with fewer span IDs."
}
