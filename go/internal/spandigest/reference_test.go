package spandigest

import (
	"hash/maphash"
	"strconv"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/langwatch/scenario/go/internal/jsjson"
	"github.com/langwatch/scenario/go/internal/jsstr"
)

// referenceFormat is the straightforward digest renderer the compiled one
// replaced: it parses, transforms and deduplicates every attribute value on
// every call. The differential test checks the compiled renderer against it.
func referenceFormat(spans []sdktrace.ReadOnlySpan) string {
	if len(spans) == 0 {
		return NoSpans
	}
	r := refRenderer{dedup: &refDedup{threshold: DedupThreshold}}
	sorted := SortByStartTime(spans)
	b := r.out.start()
	b = append(b, "Spans: "...)
	b = strconv.AppendInt(b, int64(len(spans)), 10)
	b = append(b, " | Total Duration: "...)
	b = appendDuration(b, totalDurationMs(sorted))
	r.out.buf = b
	r.out.add("")
	roots := buildHierarchy(sorted)
	for i, n := range roots {
		r.renderFull(n, 0, i == len(roots)-1)
	}
	er := renderer{out: r.out}
	er.renderErrors(spans)
	return string(er.out.buf)
}

type refRenderer struct {
	dedup *refDedup
	out   lines
	attrs []cleanAttribute
}

func refRepeatPipe(n int) string {
	s := ""
	for i := 0; i < n; i++ {
		s += "│   "
	}
	return s
}

func refTreePrefix(depth int, isLast bool) string {
	if depth == 0 {
		return ""
	}
	if isLast {
		return refRepeatPipe(depth-1) + "└── "
	}
	return refRepeatPipe(depth-1) + "├── "
}

func refAttrIndent(depth int, isLast bool) string {
	if depth == 0 {
		return "    "
	}
	if isLast {
		return refRepeatPipe(depth-1) + "    " + "    "
	}
	return refRepeatPipe(depth-1) + "│   " + "    "
}

func (r *refRenderer) renderFull(n *node, depth int, isLast bool) {
	b := append(r.out.start(), refTreePrefix(depth, isLast)...)
	r.out.buf = appendHeader(b, n.span, false)
	indent := refAttrIndent(depth, isLast)
	r.attrs = cleanAttributes(r.attrs, n.span.Attributes())
	for _, a := range r.attrs {
		r.attrLine(indent, "", a)
	}
	for _, ev := range n.span.Events() {
		r.out.add(indent + "[event] " + ev.Name)
		r.attrs = cleanAttributes(r.attrs, ev.Attributes)
		for _, a := range r.attrs {
			r.attrLine(indent, "  ", a)
		}
	}
	r.out.add("")
	for i, c := range n.children {
		r.renderFull(c, depth+1, i == len(n.children)-1)
	}
}

func (r *refRenderer) attrLine(indent, extra string, a cleanAttribute) {
	b := r.out.start()
	b = append(b, indent+extra+a.key+": "...)
	r.out.buf = r.dedup.appendValue(b, a.value)
}

type refDedup struct {
	threshold int
	seen      map[uint64]struct{}
	seed      maphash.Seed
}

func (d *refDedup) process(s string) string {
	if len(s) < d.threshold || jsstr.Len(s) < d.threshold {
		return s
	}
	if d.seen == nil {
		d.seen = map[uint64]struct{}{}
		d.seed = maphash.MakeSeed()
	}
	key := maphash.String(d.seed, normalizeForDedup(s))
	if _, dup := d.seen[key]; dup {
		return duplicateMarker
	}
	d.seen[key] = struct{}{}
	return s
}

func (d *refDedup) appendValue(dst []byte, v attribute.Value) []byte {
	if v.Type() == attribute.STRING {
		s := v.AsString()
		if jsjson.LooksLikeJSON(s) {
			if parsed, err := jsjson.Parse(s); err == nil {
				return jsjson.Append(dst, d.transform(parsed))
			}
		}
		if truncated, ok := truncateMediaURL(s); ok {
			return append(dst, truncated...)
		}
		return append(dst, d.process(s)...)
	}
	return jsjson.Append(dst, d.transform(jsValue(v)))
}

func (d *refDedup) transform(v any) any {
	return deepTransform(v, func(x any) (any, bool) {
		if part, ok := truncateMediaPart(x); ok {
			return part, true
		}
		s, ok := x.(string)
		if !ok {
			return nil, false
		}
		if jsjson.LooksLikeJSON(s) {
			if parsed, err := jsjson.Parse(s); err == nil {
				return jsjson.Stringify(d.transform(parsed)), true
			}
		}
		if truncated, ok := truncateMediaURL(s); ok {
			return truncated, true
		}
		return d.process(s), true
	})
}

func normalizeForDedup(s string) string { return string(appendNormalized(nil, s)) }

// deepTransform applies fn to v; when fn returns a replacement the branch
// stops there, otherwise it descends into arrays and objects. Mirrors the
// JS deep-transform helper. It rewrites v in place, so v must be owned by
// the caller (a fresh parse or a fresh attribute conversion).
func deepTransform(v any, fn func(any) (any, bool)) any {
	if r, replaced := fn(v); replaced {
		return r
	}
	switch x := v.(type) {
	case []any:
		for i := range x {
			x[i] = deepTransform(x[i], fn)
		}
	case jsjson.Object:
		for i := range x {
			x[i].Value = deepTransform(x[i].Value, fn)
		}
	}
	return v
}

// referenceFormatValue is the tree-based FormatValue the compiled one
// replaced.
func referenceFormatValue(v attribute.Value) string {
	if v.Type() == attribute.STRING {
		if s, ok := transformValue(v.AsString()).(string); ok {
			return s
		}
	}
	processed := transformValue(jsValue(v))
	if s, ok := processed.(string); ok {
		return s
	}
	return jsjson.Stringify(processed)
}

func transformValue(v any) any {
	return deepTransform(v, func(x any) (any, bool) {
		if part, ok := truncateMediaPart(x); ok {
			return part, true
		}
		s, ok := x.(string)
		if !ok {
			return nil, false
		}
		if truncated, ok := truncateMediaURL(s); ok {
			return truncated, true
		}
		if jsjson.LooksLikeJSON(s) {
			if parsed, err := jsjson.Parse(s); err == nil {
				return jsjson.Stringify(transformValue(parsed)), true
			}
		}
		return nil, false
	})
}
